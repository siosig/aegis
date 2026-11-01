<div align="center">
  <img src="docs/assets/logo.png#gh-light-mode-only" alt="Aegis" width="500" />
  <img src="docs/assets/logo-dark.png#gh-dark-mode-only" alt="Aegis" width="500" />
</div>

# Aegis

**AIコーディングエージェント向け DAGベース決定的コンテキストコンパイラ**

[English README](README.md) | [技術解説ガイド](docs/technical-guide.ja.md)

Aegis は、AIコーディングエージェントにアーキテクチャガイドラインを強制する MCP サーバーです。RAG の代わりに、依存関係の DAG を使って対象ファイルに必要なドキュメントを決定的にコンパイルします。検索なし。ランキングなし。決定的。

## クイックスタート

1. IDE の MCP 設定に Aegis を追加（[インストール](#インストール)を参照）
2. プロジェクトルートの `CLAUDE.md` に `aegis: 導入済み` を含む行を足し（または `mkdir .aegis` を実行し）、MCP サーバーを再起動（再接続）する
3. AI エージェントに指示: *「Aegis を初期化してアダプタルールをデプロイして」*
4. エージェントが `aegis_init_detect` → `aegis_init_confirm` → `npx @fuwasegu/aegis deploy-adapters` を自動で実行

データベースはプロジェクトルートの `.aegis/aegis.db` に保存されます。`.aegis/` ディレクトリは自身の `.gitignore` を含むため、手動設定は不要です。

MCP サーバーは、導入済みの目印があるか `--db` を指定したときだけデータベースを開きます（作成します）。目印は、プロジェクトルートの `CLAUDE.md` に `aegis: 導入済み` を含む行があること、またはプロジェクトルート配下に `.aegis/` があることの 2 種で、どちらか一方があれば導入済みとみなします。目印が `CLAUDE.md` の行だけで `.aegis/` が無いときは、`.aegis/` と `.aegis/.gitignore` を作ってから動作します。目印も `--db` も無いときは待機モードで起動します。待機モードではファイルを一切作らず、`aegis_init_detect` と `aegis_workspace_status` の 2 本だけを出し、標準エラー出力と `aegis_workspace_status` の応答で未導入であることを知らせます。プロジェクトに導入するには、上の手順 2 のとおり目印を置いて MCP サーバーを再起動してください。判定は起動時に 1 回だけ行うため、目印を置いたあとは再起動が必要です。

## インストール

**動作要件:** Node.js 26 以上。

Aegis は 3 つの MCP surface を提供します — agent と admin は必須、ssa は任意です:

| Surface | 役割 | ツール数 |
|---------|------|----------|
| **agent** | コンテキスト取得・オブザベーション記録など（Canonical Knowledge は変更不可） | 6 ツール（compile, observe, audit, known_tags, workspace_status, detect） |
| **ssa**（任意） | speck-serena-aegis の運用向け: 文書の同期・オブザベーションの処理と書庫入れ・プロポーザルの一覧／取得／承認・統計（取り込み・テンプレート更新・却下・バンドル承認は不可） | 13 ツール（共通 6 + 7） |
| **admin** | 初期化・承認・トリアージ | 24 ツール（共通 6 + Admin 専用 18） |

> agent surface だけでは初期化もプロポーザル承認もできません。この分離により、AI エージェントが人間の承認なしにアーキテクチャルールを変更することを防ぎます。（[INV-6](docs/technical-guide.ja.md)）

### Cursor

`.cursor/mcp.json` に追加:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

初期化後、`deploy-adapters` で `.cursor/rules/aegis-process.mdc` が生成されます。「コードを書く前に Aegis に相談し、違反を見つけたら報告せよ」とエージェントに指示する Cursor ルールです。

### Claude Code

```bash
claude mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
claude mcp add aegis-admin -- npx -y @fuwasegu/aegis --surface admin
```

<details>
<summary><code>.mcp.json</code> に手動で追加する場合</summary>

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

</details>

初期化後、`deploy-adapters` で `CLAUDE.md` に `<!-- aegis:start -->` セクションが追加されます（無い場合は新規作成）。

### Codex

```bash
codex mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
codex mcp add aegis-admin -- npx -y @fuwasegu/aegis --surface admin
```

<details>
<summary><code>.mcp.json</code> に手動で追加する場合</summary>

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

</details>

初期化後、`deploy-adapters` で `AGENTS.md` に `<!-- aegis:start -->` セクションが追加されます（無い場合は新規作成）。

> **注意:** Codex の MCP サポートは CLI バージョンに依存します。MCP が利用できない場合でも、生成された `AGENTS.md` の指示に従ってエージェントは Aegis のガイドラインを参照できます。

## 使い方

### 1. プロジェクトを初期化する

Admin surface を使って、空のナレッジベースで Aegis を初期化:

```
aegis_init_detect({ project_root: "/path/to/your/project", skip_template: true })
aegis_init_confirm({ preview_hash: "<detect で返されたハッシュ>" })
```

空のナレッジベースが作成されます。次のステップでアーキテクチャドキュメントを追加します。

続けて CLI でアダプタルールと Agent Skills をデプロイ:

```bash
npx @fuwasegu/aegis deploy-adapters
npx @fuwasegu/aegis deploy-adapters --targets cursor,codex  # 対象を絞る場合
```

### 2. 開発中に使う

Agent surface が AI コーディングエージェントにツールを提供します。**expanded** コンテキスト（タグ由来のドキュメント）を使う推奨フローは、セッションごとに一度 `aegis_get_known_tags`（`tag_catalog_hash` をキャッシュ）し、続けて `intent_tags` を付けてコンパイルします:

```
aegis_get_known_tags({})
aegis_compile_context({
  target_files: ["src/core/store/repository.ts"],
  plan: "アーカイブ済みオブザベーション用の新しいクエリメソッドを追加",
  intent_tags: ["<known_tags で取得したタグ>"]
})
```

`intent_tags` を省略するのは、オプションのサーバー側 SLM タガー（`--slm` 有効時）に `plan` からタグ推論させたい場合に限ります（[ADR-004](docs/adr/004-slm-role-and-strategy.md)）。expanded を使わず SLM も使わない場合は `intent_tags: []` を渡します。

ベース DAG のみ（expanded をスキップ）。`intent_tags: []` により SLM 有無に関わらず expanded / SLM タギングを行いません:

```
aegis_compile_context({
  target_files: ["src/core/store/repository.ts"],
  plan: "アーカイブ済みオブザベーション用の新しいクエリメソッドを追加",
  intent_tags: []
})
```

編集対象ファイルに関連するアーキテクチャガイドライン、パターン、制約が返されます。

### 3. アーキテクチャドキュメントを追加する

初期化後、コードベースを分析してナレッジベースにドキュメントを追加します。**admin** surface の `aegis_import_doc` で `edge_hints` 付きのドキュメントを追加:

```
aegis_import_doc({
  file_path: "/absolute/path/to/docs/architecture-guide.md",
  doc_id: "architecture-guide",
  title: "アーキテクチャガイド",
  kind: "guideline",
  tags: ["architecture"],
  edge_hints: [
    { source_type: "path", source_value: "src/domain/**", edge_type: "path_requires" }
  ]
})
```

`file_path` を使うとディスクから直接内容を読み取るため、LLM コンテキストウィンドウによる切り詰めを回避できます。各インポートは `proposal_ids` を返すので、承認して有効化します。

インポートしたドキュメントをソースファイルと同期するには:

```
aegis_sync_docs()   # コンテンツハッシュで変更を検知し、update_doc プロポーザルを作成
```

`aegis_import_doc` は **admin** surface が必要です。`aegis_sync_docs` は **admin** と **ssa** の surface で使えます。詳細な一括インポート手順は `aegis-bulk-import` skill（`deploy-adapters` でデプロイ）を参照してください。

### 4. オブザベーションを報告

エージェントがガイドラインの不足や修正を発見した場合:

```
aegis_observe({
  event_type: "compile_miss",
  related_compile_id: "<compile_context から>",
  related_snapshot_id: "<compile_context から>",
  payload: { target_files: ["..."], review_comment: "エラーハンドリングのガイドラインが不足" }
})
```

### 5. プロポーザルをレビュー

オブザベーションは自動分析されプロポーザルになります。Admin surface でレビュー・承認:

```
aegis_list_proposals({ status: "pending" })
aegis_approve_proposal({ proposal_id: "<id>" })
```

## プロジェクト共有（チームワークフロー）

Aegis は、承認済み Canonical Knowledge を Git コミットされるバンドル成果物を介してチームメンバー間で共有できます。各開発者がゼロからナレッジベースを構築する必要がなくなります。

### 仕組み

| ディレクトリ | 用途 | Git 管理? |
|-------------|------|:---------:|
| `.aegis/` | ローカルランタイムDB（オブザベーション、プロポーザル、コンパイルログ） | いいえ |
| `aegis-share/` | 承認済み Canonical Knowledge の共有スナップショット | **はい** |

### オーサリングワークスペース（ナレッジ管理者）

プロポーザル承認後、現在の Canonical 状態をエクスポート:

```bash
npx @fuwasegu/aegis share-export                # aegis-share/manifest.json + canonical.json を書き出し
npx @fuwasegu/aegis share-export --out /path    # カスタム出力ディレクトリ
```

その後、`aegis-share/` をコミット＆プッシュします。

### レプリカワークスペース（チームメンバー）

更新された `aegis-share/` を含む変更を pull した後:

```bash
npx @fuwasegu/aegis share-hydrate               # aegis-share/ から .aegis/aegis.db を再構築
npx @fuwasegu/aegis share-hydrate --replace     # 既存の初期化済み DB を上書き
npx @fuwasegu/aegis share-hydrate --bundle-dir /path  # カスタムバンドルディレクトリ
```

> **注意:** `share-hydrate` は DB 全体を置換します。ローカルの運用状態（オブザベーション、プロポーザル、コンパイルログ）は**保持されません**。これは設計上の意図です — レプリカワークスペースは共有知識の利用者であり、作成者ではありません。

### 共有ステータスの監視

Aegis はローカル DB と共有バンドル間のドリフトを自動検出します:

- **`npx @fuwasegu/aegis doctor`** — 共有状態を表示（`in_sync`, `bundle_newer`, `local_ahead`, `diverged`, `unreadable_bundle`）。対処が必要な状態では exit 1
- **`npx @fuwasegu/aegis stats`** — JSON 出力に `project_share` フィールドとして詳細ステータスを含む
- **`aegis_compile_context` の notices** — バンドルが同期していない場合、エージェントに対処のヒントを提示（例: 「`share-hydrate` を実行して更新してください」）

`not_configured` 状態（`aegis-share/` ディレクトリなし）は通知なし — 共有が設定されるまでノイズを出しません。

### 一般的なチームワークフロー

```
                 オーサリングワークスペース              レプリカワークスペース
                 ─────────────────────              ────────────────────
  プロポーザル承認 ──► share-export ──► git push ──► git pull ──► share-hydrate
                               aegis-share/ をコミット
```

1. **管理者** がナレッジベースを更新（ドキュメントインポート、プロポーザル承認、同期）
2. **管理者** が `share-export` を実行し `aegis-share/` をコミット
3. **チーム** が `git pull` → `share-hydrate --replace` を実行
4. レプリカの `compile_context` が管理者と同じガイドラインを返すようになる

## 共同オーサリング（Source-Native）

上記の DB ネイティブワークフロー（observe → propose → approve）に加えて、Aegis は **source-native** 共同オーサリングモードをサポートしています。チームメンバーが `aegis-share/source/` にある人間可読なソースファイルを編集し、プルリクエストで変更をレビューした後、データベースに materialize します。

> **重要:** `compile_context` は常にデータベースから読み取り、ソースファイルを直接参照しません。ソースファイルはオーサリングフォーマットであり、DB がランタイムフォーマットです。

### 2 つの承認レーン

| レーン | エントリーポイント | 承認メカニズム | 適したケース |
|--------|------------------|--------------|-------------|
| **DB ネイティブ** | エージェントがギャップを検出 → `aegis_observe` → `aegis_approve_proposal` | admin surface でプロポーザルを人間が承認 | エージェントのオブザベーションによるリアクティブなナレッジ改善 |
| **Source ネイティブ** | `aegis-share/source/` を編集 → PR → マージ → `share-materialize` | PR マージ = 承認 | Git ベースのコードレビューによるプロアクティブな共同編集 |

両レーンは共存します。状況に応じて使い分けるか、両方を併用してください。

### ディレクトリレイアウト

```
aegis-share/
├── manifest.json              # ディストリビューションバンドルのマニフェスト（ADR-017）
├── canonical.json             # ディストリビューションバンドルのデータ（ADR-017）
└── source/                    # 共同オーサリングソース（ADR-018）
    ├── documents/
    │   └── <doc_id>.md        # フロントマター + Markdown 本文
    ├── edges/
    │   ├── path-requires.json
    │   ├── layer-requires.json
    │   ├── command-requires.json
    │   └── doc-depends-on.json
    ├── layer-rules.json
    └── tag-mappings.json
```

### Source ネイティブワークフロー

```bash
# 1. ブートストラップ: 現在の DB をソース形式にエクスポート（初回セットアップ）
npx @fuwasegu/aegis share-source-export

# 2. ソースファイルを編集（ドキュメント、エッジ、ルール、マッピング）
#    ブランチを作成し、変更を加え、PR を作成

# 3. コミット前にバリデーション
npx @fuwasegu/aegis share-format                 # フォーマット正規化（決定的、インプレース）
npx @fuwasegu/aegis share-lint                   # エラーチェック（フォーマット後に実行）

# 4. PR マージ後: ソースを DB に適用
npx @fuwasegu/aegis share-materialize            # 変更を適用 + 自動承認
npx @fuwasegu/aegis share-materialize --dry-run  # 適用せずに変更をプレビュー

# 5. レプリカ用にバンドルをエクスポート
npx @fuwasegu/aegis share-export
```

### CI 連携

CI パイプラインに `share-lint` を追加して、マージ前にエラーを検出:

```bash
npx @fuwasegu/aegis share-lint  # エラー時 exit 1 — CI チェックに適合
```

### Phase 1 の制限事項

- ローカルオーバーレイは未サポート — 全変更は共有ソースを経由
- `share-materialize` はフル適用（インクリメンタルパッチではない）

## SLM 拡張コンテキスト — オプトイン

Aegis は llama.cpp エンジンを内蔵しており、オプションで SLM ベースの Intent Tagging を利用できます。SLM は**デフォルトで無効**です。決定的 DAG ベースのコンテキストは SLM なしでも完全に動作します。

有効にするには **agent** surface に `--slm` を追加:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent", "--slm", "--model", "qwen3.5-4b"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

SLM 有効時の初回起動で、選択されたモデルが `~/.aegis/models/` にダウンロードされます（全プロジェクトで共有）。

| モデル | サイズ | 説明 |
|--------|--------|------|
| `qwen3.5-4b` | ~2.5 GB | 推奨デフォルト — 高速・軽量 |
| `qwen3.5-9b` | ~5.5 GB | 高品質 — ベンチマークトップ |

HuggingFace URI を直接指定することも可能: `--model hf:user/repo:file.gguf`

> **レガシー:** Ollama ベースの推論を使いたい場合は `--ollama` フラグが利用可能です。`--ollama` 指定時は SLM が暗黙的に有効化されます。

## リファレンス

### MCP ツール — Agent Surface（6 ツール）

| ツール | 説明 |
|--------|------|
| `aegis_compile_context` | 対象ファイルの決定的コンテキストをコンパイル。`content_mode`（auto/always/metadata）・`max_inline_bytes`・`min_relevance`（低relevance docの省略）・`include_debug`（`debug_info`のオプトイン返却、デフォルトoff）による出力サイズ制御に対応 |
| `aegis_observe` | オブザベーション記録（compile_miss, review_correction, pr_merged, manual_note, document_import, doc_gap_detected） |
| `aegis_get_compile_audit` | 過去のコンパイルの監査ログを取得 |
| `aegis_get_known_tags` | tag_mappings の意図タグ一覧（承認ドキュメントに紐づくもの）と `knowledge_version`、キャッシュ用 SHA-256 `tag_catalog_hash` |
| `aegis_workspace_status` | 読み取り専用のワークスペーススナップショット（最近のコンパイル領域、未解決 compile_miss、保留プロポーザル数、reconcile バックログ（hash-sync/anchor-sync/semantic-review）） |
| `aegis_init_detect` | プロジェクト分析と初期化プレビュー生成 |

### MCP ツール — SSA Surface（追加 7 ツール、計 13）

speck-serena-aegis（ssa）の運用向けの任意の surface です。agent の 6 ツールに、次の 7 ツールを足して登録します。7 ツールの振る舞いは admin surface と同じです。[ADR-020](docs/adr/020-ssa-surface.md) を参照してください。

| ツール | 説明 |
|--------|------|
| `aegis_list_proposals` | プロポーザル一覧（ステータスフィルタ付き） |
| `aegis_get_proposal` | プロポーザル詳細とエビデンスの取得 |
| `aegis_approve_proposal` | 保留中のプロポーザルを承認 |
| `aegis_archive_observations` | 古いオブザベーションをアーカイブ |
| `aegis_get_stats` | ナレッジ集計とヘルスシグナル |
| `aegis_process_observations` | 未分析のオブザベーションに対して分析パイプラインを実行 |
| `aegis_sync_docs` | ファイルアンカー済みドキュメントをソースファイルと同期（reconcile-mode-aware: hash-sync, anchor-sync, semantic-review） |

### MCP ツール — Admin Surface（追加 18 ツール、計 24）

| ツール | 説明 |
|--------|------|
| `aegis_init_confirm` | プレビューハッシュで初期化を確認 |
| `aegis_list_proposals` | プロポーザル一覧（ステータスフィルタ付き） |
| `aegis_get_proposal` | プロポーザル詳細とエビデンスの取得 |
| `aegis_approve_proposal` | 保留中のプロポーザルを承認 |
| `aegis_preflight_proposal_bundle` | 同一 `bundle_id` の保留プロポーザルをドライラン検証 |
| `aegis_approve_proposal_bundle` | バンドル単位で保留プロポーザルを一括承認（原子的） |
| `aegis_reject_proposal` | プロポーザルを理由付きで却下 |
| `aegis_check_upgrade` | テンプレートバージョンのアップグレード確認 |
| `aegis_apply_upgrade` | テンプレートアップグレードのプロポーザル生成 |
| `aegis_archive_observations` | 古いオブザベーションをアーカイブ |
| `aegis_get_stats` | ナレッジ集計とヘルスシグナル |
| `aegis_list_observations` | オブザベーション一覧（outcome フィルタ: proposed / skipped / pending） |
| `aegis_import_doc` | ドキュメントを Canonical Knowledge にインポート（`content` または `file_path` 指定）。大きなコンテンツ・複数セクション・semantic-review モードに対する advisory warning を返却 |
| `aegis_analyze_doc` | ADR-015: `content` または `file_path` を ImportPlan に分析（読み取り専用） |
| `aegis_analyze_import_batch` | ADR-015: 一括取り込み分析（ドキュメント横断の重複検知） |
| `aegis_execute_import_plan` | ADR-015: ImportPlan を `bundle_id` 共有のプロポーザルに具体化 |
| `aegis_process_observations` | 未分析のオブザベーションに対して分析パイプラインを実行 |
| `aegis_sync_docs` | ファイルアンカー済みドキュメントをソースファイルと同期（reconcile-mode-aware: hash-sync, anchor-sync, semantic-review） |

### CLI サブコマンド

| サブコマンド | 説明 |
|------------|------|
| `deploy-adapters` | IDE アダプタ設定（Cursor ルール、CLAUDE.md、AGENTS.md）と Agent Skills をデプロイ |
| `maintenance` | オブザベーション処理、ドキュメント同期、アーカイブ、アップグレードチェックを実行し、最後に DB の圧縮（`db_compaction`）を行う |
| `approve-pending` | 保留中のプロポーザルを種類ごとに一括承認（`--types <t1,t2,...>` で種類を絞り込み、`--dry-run` で承認対象の列挙のみ）。admin 専用の CLI で、MCP ツールとしては公開しない（INV-6） |
| `staleness-ack` | 確認済みの Level 3 の staleness を確定する（`--doc-ids <id1,id2,...>` か `--all`、`--dry-run` で報告のみ）。文書の基準値を今のファイルから取り直し、その文書の Level 3 の `staleness_detected` 観測をアーカイブする。admin 専用の CLI で、MCP ツールとしては公開しない（INV-6） |
| `stats` | ナレッジ集計、利用状況、ヘルス、プロジェクト共有ステータスの JSON 出力 |
| `doctor` | ヘルスチェックの人間可読サマリー（問題があれば exit 1） |
| `share-export` | 承認済み Canonical Knowledge を `aegis-share/` にエクスポート |
| `share-hydrate` | 共有バンドルからローカル DB を再構築（DB 全体置換） |
| `share-source-export` | ブートストラップ: DB を人間可読な `aegis-share/source/` にエクスポート |
| `share-lint` | `aegis-share/source/` のバリデーション（パースエラー、参照切れ検出） |
| `share-format` | `aegis-share/source/` の決定的フォーマット正規化（インプレース） |
| `share-materialize` | `aegis-share/source/` を DB に適用（source-native 承認） |

```bash
npx @fuwasegu/aegis deploy-adapters                         # 全アダプタをデプロイ
npx @fuwasegu/aegis deploy-adapters --targets cursor,codex  # 対象を指定
npx @fuwasegu/aegis deploy-adapters --project-root /path    # プロジェクトルートを指定
npx @fuwasegu/aegis deploy-adapters --db /path/to/aegis.db  # カスタム DB パスを指定
npx @fuwasegu/aegis maintenance                             # オブザベーション処理、同期、アーカイブ
npx @fuwasegu/aegis maintenance --dry-run                   # レポートのみ（書き込みなし）
npx @fuwasegu/aegis approve-pending --dry-run               # 承認対象の列挙のみ（DB は変更しない）
npx @fuwasegu/aegis approve-pending --types new_doc,add_edge  # 指定した種類だけを一括承認
npx @fuwasegu/aegis staleness-ack --doc-ids plan,spec       # 確認済みのコードのドリフトを確定
npx @fuwasegu/aegis stats                                   # JSON ヘルス・利用状況データ
npx @fuwasegu/aegis doctor                                  # ヘルスチェックサマリー
npx @fuwasegu/aegis share-export                            # aegis-share/ にエクスポート
npx @fuwasegu/aegis share-hydrate --replace                 # バンドルから DB を再構築
npx @fuwasegu/aegis share-source-export                     # DB を aegis-share/source/ にエクスポート
npx @fuwasegu/aegis share-lint                              # 共有ソースのバリデーション
npx @fuwasegu/aegis share-format                            # 共有ソースのフォーマット正規化
npx @fuwasegu/aegis share-materialize                       # ソースを DB に適用
npx @fuwasegu/aegis share-materialize --dry-run             # 変更プレビュー
npx @fuwasegu/aegis --list-models                           # 利用可能な SLM モデル一覧
```

#### 運用上の注意

- **`approve-pending` の出力:** 標準出力に JSON を 1 つ（`approved`、`would_approve`、`rejected`、`would_reject`、`skipped`、`failed`）、診断を標準エラーに出力します。バンドルに属する提案（`bundle_id`）は `reason: bundled` で skipped にするため、`aegis_approve_proposal_bundle` で承認してください。同じ文書（`doc_id`）に pending の `update_doc` が複数あるときは、最も新しいもの（`created_at` が最後）だけを承認の候補にし、それより古いものは `reason: superseded` で却下します。最も新しいものも、内容が現在のソースファイル（`source_path`）と一致しなければ `reason: stale_content` で却下します（ソースファイルが無い文書は内容を比べずに承認します）。却下した提案は `rejected`（`--dry-run` では `would_reject`）に載り、その根拠の観測は再分析の対象に戻しません。バンドルに属する `update_doc` はこの選別の対象外です。すでに pending でない提案（別プロセスが先に承認した場合など）も `reason: no_longer_pending` の skipped になり、失敗には数えません。終了コードは、完了で `0`、承認の失敗を含むと `1`（成功した承認は残り、標準出力の JSON は最後まで出力されます）、使い方の誤りまたは DB を開けない場合は `2` です。
- **`staleness-ack`:** 文書がドリフトしたコードと今も合っている（または文書を直した）ことを確かめた後に実行します。`maintenance` はドリフトの無い回にしか基準値を書き直さないため、確定しない限り同じ指摘が出続けます。標準出力に JSON を 1 つ（`dry_run`、種類ごとの Level 3 の指摘の件数と新しい基準値のパス数を持つ `acknowledged`、`reason: no_linked_paths | source_unreadable` の `skipped`、`archived_observations`）出力します。Level 1〜2（文書とそのソースファイルの差）は対象外で、`sync_docs` で解消します。承認済みでない `doc_id` は、書き込みの前にエラーにします。終了コードは、完了で `0`、使い方の誤り・未知の `doc_id`・DB を開けない場合は `2` です。
- **staleness の検査対象:** `git ls-files`（追跡ファイル + 未追跡かつ `.gitignore` 対象外のファイル）に基づきます。git が使えない場合（git 未導入、git の作業ツリーの外、またはプロジェクトのルート自体が上位リポジトリの設定で無視されている場合）は従来の再帰走査に切り替わります。
- **スナップショットの保持世代:** 環境変数 `AEGIS_SNAPSHOT_RETENTION`（既定 `20`、正の整数）で、保持する直近の世代数を指定します。不正な値の場合は警告を出して既定値 `20` を使います。
- **DB の圧縮:** `maintenance` の `db_compaction` は、DB の空き領域が 1 MiB 以上かつ 25% 以上のときに限り、`maintenance` の最後に `VACUUM` を実行します（`--dry-run` では判定のみで実行しません）。

> **注意**: バージョン追跡はフルデプロイ（`--targets` なし）時のみ更新されます。部分デプロイではバージョン記録は更新されないため、「アダプタテンプレートが古い可能性があります」という通知は、フルデプロイを実行するまで残ります。

### CLI フラグ（MCP サーバーモード）

| フラグ | デフォルト | 説明 |
|--------|-----------|------|
| `--surface` | `agent` | `agent`・`ssa`・`admin` のいずれか |
| `--db` | `.aegis/aegis.db` | SQLite データベースパス |
| `--templates` | `./templates` | 同梱テンプレートディレクトリ |
| `--template-dir` | | 追加テンプレート検索パス（ローカルが同梱を上書き） |
| `--slm` | false | SLM を有効化（拡張コンテキスト: Intent Tagging） |
| `--model` | `qwen3.5-4b` | SLM モデル名または HuggingFace URI（`--slm` 必須） |
| `--list-models` | | 利用可能なモデルを表示して終了 |
| `--ollama` | false | 内蔵 llama.cpp の代わりに Ollama を使用（`--slm` を暗黙的に有効化） |
| `--project-root` | `cwd()` | プロジェクトルート（repo-relative source_path 解決とデフォルト DB パスの基準） |
| `--ollama-url` | `http://localhost:11434` | Ollama API URL（`--ollama` 使用時） |

> **js-yaml 5 の互換性:** `load()` は YAML 1.2 の Core スキーマが既定のため、利用者のテンプレートや project-share の YAML にある `yes`/`no`/`on`/`off` や先頭が 0 の数値の解釈が、YAML 1.1 の場合と異なる可能性があります。

---

## 開発

### ビルド・テスト

```bash
pnpm run build   # TypeScript コンパイル
pnpm test        # 全テスト実行（406+）
pnpm run test:watch
```

<details>
<summary>ソースからビルド</summary>

```bash
git clone https://github.com/fuwasegu/aegis.git
cd aegis
pnpm install && pnpm run build
```

</details>

### アーキテクチャ

```
┌─ MCP層 (src/mcp/) ─────────────────────┐
│ ツール登録、Surface 分離                  │
└──────────────┬──────────────────────────┘
               │
┌─ Core層 (src/core/) ───────────────────┐
│ ContextCompiler, Repository, Init,      │
│ Automation (各種 Analyzer), Tagging     │
└──────────────┬──────────────────────────┘
               │
┌─ Adapters (src/adapters/) ──────────────┐
│ Cursor, Claude ルール生成                │
└──────────────┬──────────────────────────┘
               │
┌─ Expansion (src/expansion/) ────────────┐
│ llama.cpp エンジン, IntentTagger          │
└─────────────────────────────────────────┘
```

依存は下方向のみ。Core は MCP、Adapters、Expansion からインポートしません。

### 主要コンセプト

- **Canonical Knowledge（正典）**: 承認済みアーキテクチャドキュメント + DAG エッジ
- **Observation Layer**: エージェントが報告するイベント（コンパイルミス、修正提案、PR マージ）
- **Proposed Layer**: 人間の承認を必要とする自動生成プロポーザル
- **Snapshots**: Canonical Knowledge のイミュータブルなコンテンツアドレス可能バージョン

## ライセンス

ISC
