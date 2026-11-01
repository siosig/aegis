# Aegis Technical Guide

[English version](technical-guide.md)

Aegis の内部で使われている決定論的アルゴリズムとアーキテクチャの設計判断を解説するドキュメント。

## 目次

1. [コンテキストコンパイルの4ステップルーティング](#1-コンテキストコンパイルの4ステップルーティング)
2. [Specificity と Priority による決定論的ソート](#2-specificity-と-priority-による決定論的ソート)
3. [レイヤ解決アルゴリズム](#3-レイヤ解決アルゴリズム)
4. [Init プロファイルスコアリング](#4-init-プロファイルスコアリング)
5. [Snapshot とコンテンツアドレス可能バージョニング](#5-snapshot-とコンテンツアドレス可能バージョニング)
6. [Pessimistic Claim パターン（同時実行安全性）](#6-pessimistic-claim-パターン同時実行安全性)
7. [Proposal 重複排除（Semantic Key）](#7-proposal-重複排除semantic-key)
8. [Preview Hash による TOCTOU 防止](#8-preview-hash-による-toctou-防止)
9. [SLM Intent Tagging と Grammar-Constrained Generation](#9-slm-intent-tagging-と-grammar-constrained-generation)
10. [不変条件（Invariants）](#10-不変条件invariants)

---

## 1. コンテキストコンパイルの4ステップルーティング

Aegis のコア機能。`compile_context` はファイルパスから必要なドキュメントを **検索ではなくグラフ走査** で決定的に解決する。

### アルゴリズム

```
入力: target_files, target_layers?, command?, plan?

Step 1: path_requires
  ├─ 全 path_requires エッジを取得
  ├─ 各エッジの source_value (glob) を target_files に対してマッチング (picomatch)
  └─ マッチしたエッジ → ソート → 対象 doc_id を収集

Step 2: layer_requires
  ├─ レイヤ解決（→ §3）で対象レイヤ名を決定
  ├─ 全 layer_requires エッジの source_value とレイヤ名をマッチング
  └─ マッチしたエッジ → ソート → 対象 doc_id を収集

Step 3: command_requires
  ├─ request.command が存在する場合のみ
  ├─ 全 command_requires エッジの source_value と完全一致
  └─ マッチしたエッジ → ソート → 対象 doc_id を収集

Step 4: doc_depends_on 推移閉包
  ├─ Step 1-3 で収集した doc_id 群を起点に
  ├─ doc_depends_on エッジを再帰的に辿る（BFS/推移閉包）
  └─ 到達可能な全 doc_id を収集

出力: documents[] + resolution_path[] + templates[]
```

### 決定論性の保証

同じ入力に対して **常に同じ出力** を返す。これが RAG との根本的な違い。

- P-1 の対象: `base`（documents, resolution_path, templates）、`expanded`、`warnings`
- P-1 の対象外: `compile_id`（UUID）、`notices`（アダプタバージョン状態などの運用メタデータ）
- `notices` はサーバ実行時の状態により変動し、compile_log には記録されない
- エッジのソートが決定的（→ §2）
- ドキュメントの表示順も決定的

### 計算量

- Step 1: O(E_path × F) — E_path: path_requires エッジ数, F: target_files 数
- Step 2: O(R × F + E_layer × L) — R: layer_rules 数, L: 解決レイヤ数
- Step 3: O(E_cmd) — E_cmd: command_requires エッジ数
- Step 4: O(V + E_dep) — 標準的なグラフ走査

通常のプロジェクトでは全ステップ合計 O(数百) 程度で十分高速。

---

## 2. Specificity と Priority による決定論的ソート

複数のエッジが同じドキュメントを指す場合、表示順序を一意に決定する必要がある。

### ソートキー（3段階）

```
1. specificity DESC  — より具体的なパターンが優先
2. priority ASC      — 小さい数値が高優先度
3. edge_id ASC       — 最終タイブレーカ（UUID の辞書順）
```

### Specificity の計算

glob パターンの「具体性」をスコア化する:

```
src/**              → specificity 低（広範囲にマッチ）
src/core/**         → specificity 中
src/core/store/*.ts → specificity 高（狭い範囲にマッチ）
```

具体的な計算ロジック:
- パスの `/` セパレータ数をベースにする
- `**` は汎用的なので重みが低い
- リテラルのディレクトリ名は重みが高い

### edge_id タイブレーカの重要性

specificity と priority が完全に同じエッジが存在しうる。edge_id（UUID）の辞書順で最終的なタイブレーカとする。これは **テンプレートの seed_edges が生成順に決定的な ID を持つ** ため、実質的にテンプレート定義順を反映する。

---

## 3. レイヤ解決アルゴリズム

ファイルパスからアーキテクチャレイヤを推定する。

### アルゴリズム

```
入力: target_files[], layer_rules[]

1. layer_rules をソート:
   specificity DESC → priority ASC → rule_id ASC

2. 各 target_file について:
   a. ソート済みルールを上から順にマッチング
   b. 最初にマッチしたルールの layer_name を採用
   c. マッチしなければスキップ

3. 結果: 重複排除されたレイヤ名の集合
```

### First-match wins の設計理由

最も具体的なルールが先にマッチするようソートされているため、`src/core/store/*.ts` → `infrastructure` と `src/**` → `application` が共存しても、前者が優先される。

### 明示的指定

`target_layers` が明示的に渡された場合、推論はスキップされる（ユーザーの明示的な意図を尊重）。

---

## 4. Init プロファイルスコアリング

プロジェクトのスタックを検出し、最適なテンプレートを選択する。

### スタック検出

```
detectStack(projectRoot):
  ├─ package.json 存在？ → has_npm = true
  ├─ tsconfig.json 存在？ → has_typescript = true
  ├─ composer.json 存在？ → has_composer = true
  ├─ requirements.txt / pyproject.toml 存在？ → has_python = true
  └─ src/ 存在？ → has_src = true
```

### プロファイルスコアリング

各テンプレートは `manifest.yaml` に `detection_rules` を持つ:

```yaml
detection_rules:
  - check: file_exists
    target: package.json
    weight: 3
  - check: file_contains
    target: package.json
    pattern: "@modelcontextprotocol/sdk"
    weight: 5
```

スコア = Σ(マッチしたルールの weight)

### プロファイル選択の決定論性

```
1. score DESC でソート
2. score が同じ場合 → profile_id ASC でソート（辞書順タイブレーカ）
3. トップの confidence が 'high' かつ同スコアが複数 → block（曖昧）
4. トップの confidence が 'low' → warn（進行可能だが注意喚起）
5. タイ（非 high）→ warn して辞書順で最初のものを auto-select
```

---

## 5. Snapshot とコンテンツアドレス可能バージョニング

### 設計

Canonical Knowledge のバージョンは **イミュータブルな Snapshot** として管理される。

```
knowledge_meta.current_version = 1, 2, 3, ...  (単調増加)

Snapshot #3:
  ├─ snapshot_docs: [{doc_id, content_hash}, ...]
  ├─ snapshot_edges: [{edge_id, source_type, ...}, ...]
  └─ snapshot_layer_rules: [{rule_id, path_pattern, ...}, ...]
```

### 世代の刈り込み

Snapshot を作成するたびに（`createSnapshot()` の末尾で）、保持する世代以外の内容行を刈り込む。

- 保持する世代: `knowledge_version` 降順の直近 N 世代（既定 20。環境変数 `AEGIS_SNAPSHOT_RETENTION` で変更）に加えて、`compile_log`・`observations`・`init_manifest` から参照される世代
- 保持外の世代は、`snapshot_docs`・`snapshot_edges`・`snapshot_layer_rules` の内容行だけを削除する。`snapshots` のヘッダ行は残る
- `AEGIS_SNAPSHOT_RETENTION` は正の整数のみ有効。無効な値は警告を stderr に 1 回出して既定値になる
- 刈り込みの失敗は承認を失敗させない。stderr に出力して、次回の Snapshot 作成時に再試行する

### 運用上の注意

- **`approve-pending`**: `aegis approve-pending` は pending の提案を 1 回の実行でまとめて承認する。CLI（admin）専用で、MCP には公開しない（INV-6）。提案は固定の型順 `APPROVE_PENDING_TYPE_ORDER`（`bootstrap`、`new_doc`、`update_doc`、`add_edge`、`retarget_edge`、`remove_edge`、`deprecate`、`materialize`）に 1 件ずつ承認する。`--types <t1,t2,...>` で提案の型を絞り、`--dry-run` で DB を変えずに承認対象を列挙する。束ねた提案（`bundle_id` を持つもの）は `reason: bundled` で skipped にし、`aegis_approve_proposal_bundle` で承認する。同じ文書（`doc_id`）に pending の `update_doc` が複数あるときは、最も新しいもの（`created_at` が最後）だけを承認の候補にし、それより古いものは `reason: superseded` で却下する。最も新しいものも、内容が現在のソースファイル（`source_path`）と一致しなければ `reason: stale_content` で却下する（ソースファイルが無い文書は内容を比べずに承認する）。却下した提案は `rejected`（`--dry-run` では `would_reject`）に載り、その根拠の観測は再分析の対象に戻さない。バンドルに属する `update_doc` はこの選別の対象外である。承認の直前に pending でなかった提案と、承認トランザクションが失敗した後に再取得して pending でなかった提案（別プロセスが先に承認した場合など）も、失敗ではなく `reason: no_longer_pending` の skipped にする。失敗を含むときの終了コードは 1 で、標準出力の JSON を切らないよう `process.exitCode` で設定する。
- **`staleness-ack`**: `aegis staleness-ack (--doc-ids <id1,id2,...> | --all) [--dry-run]` は、人が確かめた Level 3 のドリフトを確定する。CLI（admin）専用で、MCP には公開しない（INV-6）。選んだ承認済みの文書のうち、対象のパスを持つものについて、今の基準値に対する Level 3 の指摘を数え、基準値を今のファイルから取り直し、その文書のアーカイブされていない Level 3 の `staleness_detected` 観測をアーカイブする（1 トランザクション）。アーカイブするのは、`maintenance` がアーカイブされていない観測と同じ内容の指摘を記録しないためで、残すと同じドリフトが再び起きたときに記録されない。対象のパスが無い文書は `reason: no_linked_paths`、ソースファイルを読めない文書は `reason: source_unreadable` で skipped にする。Level 1〜2 には触れない。承認済みでない `doc_id` は、書き込みの前に失敗にする（終了コード 2）。
- **`edges`**: `aegis edges --json [--project-root <DIR>] [--db <PATH>]` は、承認済み（`status = 'approved'`）のエッジの全件を、対象文書の `source_path` 付きで、`{ schema_version, knowledge_version, edges }` の JSON 1 つとして stdout に出す。CLI 専用で、MCP には公開しない。`Repository.listApprovedEdgesWithSourcePath` が `edges` に `documents` を LEFT JOIN して `source_path` を引くので、対象文書の状態（承認済みか）を問わず、無ければ `null` になる。並びは `ORDER BY e.edge_type, e.source_value, e.target_doc_id, e.edge_id` で、同じ DB の内容からは常に同じバイト列が出る（P-1）。`--json` は必須で、無ければ引数の誤り（終了コード 2）になる。引数は `node:util` の `parseArgs`（strict）で解析する。成功時は `process.exit()` を呼ばず `process.exitCode` で終了コードを返す（stdout の JSON を切らないため）。引数の誤り・DB ファイルが無い・DB を読めないときの終了コードは 2 で、1 は使わない。読み取り専用で、`openDatabaseSnapshot`（ロックを取らず、`dbPath = null` のメモリ上の複製）で DB を開く。ほかのプロセスがロックを持っていても待たず、DB ファイルとその隣のファイル（`<db>.lock`・`.aegis/.gitignore` 等）を作成・変更・削除せず、`runInitialBaselineSourcePathMigration` も呼ばない。古い DB の `source_path` は正規化されずにそのまま出る。
- **`resolve`**: `aegis resolve [--json] [--project-root <DIR>] [--db <PATH>] [--] <path>...` は、渡したパスごとに、`aegis_compile_context` の base が配る文書を `doc_id`・`source_path`・当たった経路（`resolution_path`）付きで、`{ schema_version, knowledge_version, results }` の JSON 1 つとして stdout に出す。CLI 専用で、MCP には公開しない。`--json` は受け付けるが、常に JSON を出す。各パスは `normalizeTargetPath` で字句的に正規化する（`\` を `/` に置き換え、絶対パスは `--project-root` からの相対パスにし、`.`・`..`・重なった `/` を畳む。symlink は解かない）。ルートそのもの・ルートの外・空文字列のパスは引数の誤りで、DB を開かない。正規化したパスごとに `ContextCompiler.routeBase({ target_files: [p] })` を呼んで compile と同じ照合を通し、`kind` が `template` の文書を除いた文書と `resolution_path` を出す。delivery の割り当て（allocator）を通らないので、`compile_context` が予算超過で失敗するパスでも結果を返す。スナップショットが無い未初期化の DB では、すべてのパスの `documents` と `resolution_path` を `[]` にして返す。`edges` と同じく読み取り専用で（`openDatabaseSnapshot`、ロック無し、ファイルに書かず、`runInitialBaselineSourcePathMigration` を呼ばない）、`compile_log` も書かない。
- **staleness の検査対象**: `maintenance` は `git ls-files --cached --others --exclude-standard`（git 管理下のファイルと、git の無視対象ではない未追跡ファイル）で検査対象を列挙する。git の作業ツリーの外、`git` が使えない環境、またはプロジェクトのルート自体が上位リポジトリの設定で無視されているとき（`git check-ignore -q -- .` が終了コード 0）は、従来のディレクトリ走査にフォールバックする。作業ツリー内で `git ls-files` 自体が失敗したときは、フォールバックせず `maintenance` を失敗にする。基準値にあるパスのうち、今の一覧の対象から外れるもの（`git check-ignore` が無視と判定する、または `node_modules` などの除外ディレクトリの配下にある）は、ファイルが消えていても `linked_file_removed` を出さない。旧版のディレクトリ走査で作った基準値に入っている `.venv/` などの無視対象のファイルを毎回指摘しないためである。それらのパスは、その文書にほかの指摘が無くなった回に基準値から消える。基準値は指摘の無い回にしか書き直されないため、文書の `path_requires`／`path` のエッジを承認で変えたとき（`add_edge`・`retarget_edge`・`remove_edge`、およびエッジを変える `materialize`）は、その文書の基準値を消し、その文書の Level 3 の `staleness_detected` 観測をアーカイブする（付け替えでは変更前と変更後の両方の文書）。次の `maintenance` が指摘なしで基準値を取り直すので、エッジの変更がその文書のドリフトの確認を兼ね、`staleness-ack` は要らない。
- **未導入のプロジェクト（待機モード）**: 導入済みの目印は 2 種で、プロジェクトルートの `CLAUDE.md` にある `aegis: 導入済み` を含む行、または `.aegis/` である。目印のどちらかがあるか `--db` を明示したときだけ、MCP サーバーは DB を開く（作成する）。目印が `CLAUDE.md` の行だけなら `.aegis/` を作る。`--db` を明示した場合は、従来どおりディレクトリと DB を作る。目印が無く `--db` も無いときは待機モードで動作し、ファイルを作らず、`aegis_init_detect` と `aegis_workspace_status` の 2 本だけを出す。標準エラー出力の 1 行と `aegis_workspace_status` の応答の先頭の 1 文で未導入を知らせる。判定は起動時に 1 回だけで、導入するには目印を置いて MCP サーバーを再起動する。全作業ディレクトリでサーバーを起動するユーザースコープのプラグインが、Aegis を導入していないプロジェクトに空の DB を残さず、使えないツールの定義でエージェントの文脈を使わないための挙動である（ADR-019）。CLI のサブコマンドは変わらない。
- **動作環境**: Node.js 26 以上。

### 単調増加バージョン (INV-4)

```
approveProposal():
  1. current_version を読む
  2. new_version = current_version + 1
  3. Snapshot を new_version で作成
  4. knowledge_meta.current_version を更新
  → SQLite トランザクション内で原子的に実行
```

ロールバックは不可。バージョンは絶対に減らない。

### Content Hash

ドキュメントの `content_hash` は SHA-256。同じ内容 → 同じハッシュ → 変更検出が可能。

### 監査性 (INV-5)

`compile_log` テーブルが全コンパイルを記録:
- どの Snapshot を使ったか
- どのドキュメントが返されたか（base + expanded）
- リクエスト内容

→ 「なぜこのドキュメントが返されたのか」を事後的に追跡可能。

---

## 6. Pessimistic Claim パターン（同時実行安全性）

### 問題

`analyzeAndPropose` は非同期。複数の MCP クライアントが同時に呼び出すと、同じ Observation を二重処理するリスクがある。

### 解決策: Pessimistic Claim

```
analyzeAndPropose():
  1. 未分析 Observation を取得
  2. 即座に analyzed_at を SET（= claim を取る）
  3. 非同期で analyzer.analyze() を実行
  4. 成功 → proposals を作成
  5. 失敗 → analyzed_at を NULL に戻す（= claim をリリース）
```

```
時間軸 →
────────────────────────────────────────────
Call A: [claim] ─── [analyze] ─── [propose] ✓
Call B:         [claim: 空] → 即完了（何もない）
────────────────────────────────────────────
```

### リカバリ

analyze() だけでなく propose() の失敗も catch して claim をリリース。これにより、一時的なエラーで Observation が永久にスタックすることを防ぐ。

---

## 7. Proposal 重複排除（Semantic Key）

### 問題

同じ意味の Proposal が複数作られると、管理者に二重レビューを強いる。

### Semantic Key

各 proposal_type ごとに「意味的に同一」を判定するキーを抽出:

```
add_edge:  → "{source_type}:{source_value}:{target_doc_id}:{edge_type}"
new_doc:   → "{doc_id}"
update_doc: → "{doc_id}"
deprecate: → "{entity_type}:{entity_id}"
bootstrap: → "bootstrap"
```

### グローバルスコープ

重複チェックは **全 pending proposal** に対して行われる（Observation スコープではない）。これにより:

- 異なる Observation から同じ `update_doc` が提案されても1つだけ作られる
- 管理者は1回のレビューで済む

---

## 8. Preview Hash による TOCTOU 防止

### 問題

`init_detect` と `init_confirm` は別々の呼び出し。間にテンプレートファイルが変更されたら、ユーザーが確認したプレビューと実際にマテリアライズされるデータが異なる可能性がある。

### 解決策

```
init_detect():
  1. テンプレートを解決
  2. 全生成データ（docs, edges, layer_rules）をJSON化
  3. SHA-256 ハッシュを計算 = preview_hash
  4. preview_hash とデータをインメモリキャッシュに保存

init_confirm(preview_hash):
  1. キャッシュから preview_hash でルックアップ
  2. マッチしなければ → エラー（TOCTOU 検出）
  3. マッチすれば → キャッシュのデータをそのまま使用
```

preview_hash はドキュメント内容のハッシュ、エッジ構造、プレースホルダ値をすべて含む。1ビットでも変われば異なるハッシュになる。

---

## 9. 拡張コンテキスト: Agent の `intent_tags` と SLM フォールバック

### 目的

DAG ルーティングでは到達しないドキュメントを **expanded context** として返す。キーは `tag_mappings` により解決される **intent tags**。

### 優先順位（ADR-004 D-8）

```
1. compile_context に intent_tags が含まれる場合（[] 含む）:
   - そのタグのみを使用（正規化し、tag_mappings の既知タグにフィルタ）。
   - タグ選定に SLM は使わない。
   - [] は expanded を明示的に不要とする。
2. intent_tags を省略し、かつ SLM が有効（--slm）の場合:
   - plan から SLM がタグを推論（候補は tag_mappings 由来）。
3. intent_tags を省略し、SLM が無効（デフォルト）の場合:
   - expanded なし（ベース DAG のみ）。
```

LLM エージェントでは `aegis_get_known_tags` で `tag_catalog_hash` をキャッシュし、サブセットを `intent_tags` として渡すことを推奨する（`plan` は relevance 順序などに利用）。

### 前提: SLM はオプトイン

SLM は `--slm` フラグで明示的に有効化される。デフォルトでは無効であり、Base Context（決定的 DAG）のみで動作する。これはコア機能が外部依存なしに動作することを保証するための設計判断（ADR-004）。SLM による推論は **intent_tags を省略したとき** にのみ行われる。

### SLM アルゴリズム（intent_tags 省略かつ --slm 有効時）

```
1. plan テキストを SLM に入力
2. tag_mappings テーブルから動的に取得したタグリストから
   関連するタグを JSON 形式で出力させる
3. タグ → tag_mappings テーブルでドキュメントにマッピング
4. base context に含まれないドキュメントのみを expanded として返す
```

タグリストはハードコードされた定数ではなく、`tag_mappings` テーブルから動的に取得される。テンプレートブートストラップ時や Proposal 承認時にタグが登録され、プロジェクトの成長とともにタグ語彙が拡張される。

### Grammar-Constrained Generation (llama.cpp)

node-llama-cpp の Grammar 機能を使い、SLM の出力を **トークン生成レベルで** JSON スキーマに制約する:

```typescript
const grammar = await llama.createGrammarForJsonSchema({
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } }
  }
});
```

これにより:
- JSON パース失敗が原理的に起こらない
- 「JSONっぽいが壊れた出力」の対処が不要
- 小型モデルでも高い成功率

### モデル管理

```
~/.aegis/models/             ← 全プロジェクト共有
  ├─ qwen3.5-4b-instruct-q4_k_m.gguf
  └─ ...

--slm 有効時の初回起動で HuggingFace からダウンロード（resolveModelFile）
SLM 無効時（デフォルト）はモデルのダウンロードも初期化も一切行われない
```

---

## 10. 不変条件（Invariants）

Aegis が維持する6つの不変条件:

### INV-1: データ整合性
- 全エッジの `target_doc_id` が既存ドキュメントを参照
- `doc_depends_on` が DAG を形成（循環なし）
- FK 制約 + アプリケーションレベルのバリデーション

### INV-2: DAG 整合性
- `doc_depends_on` エッジが閉路を形成しないことをトランザクション時に検証
- 推移閉包計算が有限回で終了することを保証

### INV-3: Snapshot 不変性
- Snapshot 作成後、その内容は変更不可
- `snapshot_docs`, `snapshot_edges`, `snapshot_layer_rules` は INSERT-only
- 保持外の世代（直近 N 世代、および `compile_log`・`observations`・`init_manifest` から参照されない世代）の内容行は刈り込まれうる（「5. Snapshot とコンテンツアドレス可能バージョニング」の「世代の刈り込み」を参照）。残した行は変更しない

### INV-4: 単調増加バージョン
- `knowledge_meta.current_version` は常に +1
- 減少やスキップは起きない
- SQLite トランザクションで原子性を保証

### INV-5: 監査可能性
- 全 `compile_context` 呼び出しが `compile_log` に記録される
- 全 Proposal が作成〜解決まで追跡可能
- Observation → Proposal の証拠チェーン（`proposal_evidence`）

### INV-6: 権限分離
- Agent Surface: 読み取りと Observation 層への書き込みのみ（6 ツール: 読み取り専用の `aegis_get_known_tags`・`aegis_workspace_status` を含む）
- SSA Surface: agent の 6 ツールに、文書の同期・Observation の処理と書庫入れ・Proposal の一覧／取得／承認・統計を足したもの（13 ツール: 共通 6 + 7）。取り込み・テンプレート更新・却下・init_confirm・バンドルの承認は不可で、サービス層も `SSA_ALLOWED_OPERATIONS` の操作だけを許す（ADR-020）
- Admin Surface: Canonical 変更を含む全操作（24 ツール: 共通 6 + Admin 専用 18）
- AI エージェントが直接アーキテクチャを変更することを構造的に防止
