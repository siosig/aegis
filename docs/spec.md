---
description: "aegis（このフォーク）の現行の外部仕様（MCP サーバーの起動引数、DB の場所と待機モード、サーフェスごとのツール、aegis_compile_context の入出力、CLI のサブコマンドと終了コード、環境変数、永続ファイル、フォーク固有の振る舞い）。ツールや CLI の挙動を変える・呼び出し方を確かめる・既定値を調べるときに読む。"
updated: 2026-11-01
keywords: [aegis, MCP, surface, agent, admin, ssa, compile_context, delivery, notices, CLI, exit code, 終了コード, maintenance, approve-pending, staleness-ack, share-export, share-hydrate, share-materialize, .aegis, aegis.db, in-memory, 未導入, dormant, 待機モード, CLAUDE.md, AEGIS_SNAPSHOT_RETENTION]
---
# aegis 仕様

## 概要（簡潔に）

- aegis は、編集対象のファイルパスから DAG（パスと文書を結ぶエッジ）をたどり、AI エージェントに渡す文書の集合を決定的に返す MCP サーバー（stdio）である。パッケージは `@fuwasegu/aegis` 版 1.1.0、入口は `dist/main.js`、Node.js 26 以上を要する。
- MCP のツールは 3 つのサーフェスに分かれる。`agent` サーフェスは 6 ツール、`ssa` サーフェスは agent の 6 ツールに 7 ツールを足した 13 ツール、`admin` サーフェスは agent の 6 ツールに管理用の 18 ツールを足した 24 ツールを登録する（`agent` ⊂ `ssa` ⊂ `admin`）。ただし、プロジェクトに導入の目印が無く `--db` も無いときは待機モードで起動し、サーフェスによらず 2 ツール（`aegis_init_detect`・`aegis_workspace_status`）だけを登録する。
- 知識の正本（Canonical Knowledge）は SQLite の DB にある。MCP サーバーは、`--db` を明示したとき、または導入の目印（プロジェクトルートの `CLAUDE.md` の `aegis: 導入済み` を含む行、または `.aegis`）があるときだけ DB ファイルを開く・作る。どちらでもなければ待機モードで動き、空のインメモリ DB を使い、ファイルを作らず、「未導入」を stderr と `aegis_workspace_status` の応答で知らせる。
- 第 1 引数がサブコマンド名なら MCP サーバーではなく CLI として動く（`deploy-adapters`・`maintenance`・`approve-pending`・`staleness-ack`・`stats`・`doctor`・`share-*` の 6 種）。
- 内部設計と「元に戻してはいけない判断」の理由は `docs/plan.md` に置く。本書は外から観測できる振る舞いだけを書く。

## MCP サーバーの起動引数

第 1 引数がサブコマンド名でなければ MCP サーバーとして起動する。未知のフラグは警告なしに無視する。

| フラグ | 既定値 | 効果 |
|---|---|---|
| `--surface <agent\|ssa\|admin>` | `agent` | 登録するツールの集合を選ぶ。`agent`・`ssa`・`admin` 以外の値（大文字の `SSA` を含む）は stderr に `Invalid surface: <値>. Must be one of: agent, ssa, admin.` を出して終了コード 1 で終わる |
| `--db <PATH>` | `<project-root>/.aegis/aegis.db` | DB ファイルのパス。指定すると `.aegis/` の有無によらずこのファイルを開く・作る |
| `--project-root <PATH>` | 起動時のカレントディレクトリ | 既定の DB の位置と、`source_path` を repo 相対で解く基準 |
| `--templates <PATH>` | パッケージ内の `templates/`（`dist/` の 1 つ上） | 同梱テンプレートの場所 |
| `--template-dir <PATH>` | なし | 追加のテンプレート検索パス。複数回指定できる |
| `--slm` | 無効 | 内蔵の llama.cpp による SLM（意図タグの推定）を有効にする |
| `--no-slm` / `--no-ollama` | なし | SLM を無効にする |
| `--model <NAME>` | `qwen3.5-4b` | SLM のモデル名か HuggingFace の URI（`hf:user/repo:file.gguf`）。これだけでは SLM を有効にしない |
| `--ollama` | 無効 | 内蔵エンジンの代わりに Ollama を使う。SLM も有効にする |
| `--ollama-url <URL>` | `http://localhost:11434` | Ollama の API の URL |
| `--ollama-model <NAME>` | なし | `--model` と同じ値（モデル名）を設定し、SLM も有効にする。Ollama を選ぶのは `--ollama` だけで、これだけでは内蔵エンジンを使う |
| `--list-models` | なし | 選べるモデルを stderr に出して終了コード 0 で終わる |

- 同梱のモデルの一覧は `qwen3.5-4b`（既定）と `qwen3.5-9b` で、ダウンロード先は `~/.aegis/models/`（全プロジェクトで共有）である。
- SLM の初期化に失敗した、または Ollama に接続できないときは、stderr にログを出して SLM なしで起動を続ける。
- 起動に成功すると stderr に `Aegis MCP server started (surface: <surface>)` を出す。起動中の想定外の例外は `Fatal error:` を出して終了コード 1 で終わる。
- MCP の initialize で名乗るサーバー名は `aegis-<surface>`（`aegis-agent`・`aegis-ssa`・`aegis-admin`）、版は `0.1.0` で、パッケージの版とは連動しない。
- 起動時の `source_path` の正規化（ADR-013 の baseline の移行）は `admin` で起動したときだけ行い、`agent`・`ssa` では行わない。

## DB の場所と待機モード

MCP サーバーは、起動時に 1 回だけ、次の順でモードと DB を決める。

1. `--db` を明示したとき: 目印を見ずに通常モードで起動し、`--db` のパスの DB を使う。
2. `--db` が無く、`CLAUDE.md` の目印か `.aegis` のどちらかがあるとき: 通常モードで起動し、`<project-root>/.aegis/aegis.db` を使う。目印が `CLAUDE.md` の行だけで `.aegis/` が無いときは、`.aegis/` と内容 `*` の `.aegis/.gitignore` を作る。
3. `--db` が無く、目印がどちらも無いとき: 待機モードで起動する。空のインメモリ DB を使い、ディレクトリもファイルも作らない。stderr に次の 1 行を出す。

```
[aegis] Dormant mode: Aegis is not installed in <project-root> (no line containing "aegis: 導入済み" in CLAUDE.md and no .aegis/). Only aegis_init_detect and aegis_workspace_status are available and nothing is written to disk. To install, add a line containing "aegis: 導入済み" to CLAUDE.md or create .aegis/, then restart the MCP server.
```

通常モードでは、DB ファイルの親ディレクトリを作り、その親ディレクトリに `.gitignore` が無ければ内容 `*` で作り、DB ファイルを開く（無ければ作る）。

- 導入の目印は次の 2 種である。実装は `src/core/init/install-marker.ts`。
  - `<project-root>/CLAUDE.md`（プロジェクトルートの 1 か所だけ）の本文に、`aegis: 導入済み` が部分一致で含まれる。全角・半角、大文字・小文字、空白などの揺れは吸収しない。`CLAUDE.md` が無い、または読めないときは目印が無いものとして扱う。
  - `<project-root>/.aegis` が存在する。ファイルでも存在扱いにする（そのあと DB を開く処理が失敗する）。
- 待機モードでは、サーフェスによらず `aegis_init_detect`・`aegis_workspace_status` の 2 ツールだけを登録し、resource `aegis://guide/workflow` も登録しない。タガー（IntentTagger）は作らない。ほかのツールはツール一覧に出ない（「サーフェスとツール一覧」の節）。
- 目印が `CLAUDE.md` の行だけで、`.aegis/` を作れない（プロジェクトルートが書き込み不可など）ときは、待機モードに落とさず、`EACCES` などの `Fatal error` で終了コード 1 になる（仕様として受け入れている）。
- 判定は起動時に 1 回だけで、起動中に目印を監視しない。導入の手順は「`CLAUDE.md` に `aegis: 導入済み` を含む行を足す（または `.aegis/` を作る）、MCP サーバーを再起動（再接続）する」である。
- `--db` を明示したときは、親ディレクトリに `.gitignore`（内容 `*`）が無ければ作る。プロジェクトルートなどを親に持つパスを指定すると、そのディレクトリに `.gitignore` ができる。
- 待機モードの判定は MCP サーバーの起動だけに効く。CLI のサブコマンドは DB ファイルの有無で判定し、`share-hydrate` 以外は DB ファイルが無ければ失敗する（「CLI のサブコマンドと終了コード」の節）。
- 既存の DB ファイルが 0 バイトのときは 1 度だけ読み直し、それでも空なら開くことを拒否してエラーにする。
- DB が初期化済みで、`adapter_meta` に記録した版がパッケージの版と違う（または記録が無い）ときは、起動時に stderr へ `[aegis] Adapter templates may be outdated. Run \`npx @fuwasegu/aegis deploy-adapters\` to update.` を出し、`aegis_compile_context` の `notices` にも載せる。

## サーフェスとツール一覧

`agent` の 6 ツールは 3 つのサーフェスすべてに登録する。`aegis_list_proposals`・`aegis_get_proposal`・`aegis_approve_proposal`・`aegis_archive_observations`・`aegis_get_stats`・`aegis_process_observations`・`aegis_sync_docs` の 7 ツールは `ssa` と `admin` に、残りの管理用の 11 ツールは `admin` にだけ登録する。サービス層でも、`agent` はすべての管理用の操作を、`ssa` は `SSA_ALLOWED_OPERATIONS`（上の 7 ツールが使う操作と、それらが内部で呼ぶ `analyzeAndPropose`）以外の操作を `SurfaceViolationError` で拒否する（ADR-020）。

待機モードでは、サーフェスによらず `aegis_init_detect`・`aegis_workspace_status` の 2 ツールだけを登録し、resource も出さない。待機モードの `aegis_workspace_status` は、`content[0]` に次の 1 文を、`content[1]` に JSON を返す。

```
Aegis is in dormant mode: it is not installed in this project (no line containing "aegis: 導入済み" in CLAUDE.md and no .aegis/), so the database is empty and in-memory. To install, add a line containing "aegis: 導入済み" to the project's CLAUDE.md or create .aegis/, then reconnect the MCP server.
```

| ツール | サーフェス | 引数（主なもの） | 振る舞い |
|---|---|---|---|
| `aegis_compile_context` | agent・admin・ssa | 「aegis_compile_context の引数」の節 | 対象ファイルに対する文書の集合を返す。読み取りのほか `compile_log` に 1 行記録する |
| `aegis_observe` | agent・admin・ssa | `event_type`、`related_compile_id`、`related_snapshot_id`、`payload` | Observation を 1 件記録するだけで、提案は作らない（「aegis_observe のイベント種別」の節） |
| `aegis_get_compile_audit` | agent・admin・ssa | `compile_id` | 過去の compile の記録（要求・返した doc_id・`audit_meta`）を返す |
| `aegis_get_known_tags` | agent・admin・ssa | なし | 承認済みの文書に解決できる意図タグの一覧、`knowledge_version`、タグ一覧の JSON の SHA-256 である `tag_catalog_hash` を返す |
| `aegis_workspace_status` | agent・admin・ssa | `window_hours`（1〜168、既定 24） | 直近に compile された領域、未解決の `compile_miss`、pending の提案数、reconcile の滞留数（`hash_sync_stale`・`anchor_sync_stale`・`semantic_review_pending`）を返す |
| `aegis_init_detect` | agent・admin・ssa | `project_root`、`skip_template` | プロジェクトを解析して初期化のプレビューと `preview_hash` を返す（読み取りのみ） |
| `aegis_init_confirm` | admin | `preview_hash` | プレビューを確定して Canonical を初期化する。プレビューはプロセス内にだけ保持するので、`aegis_init_detect` と同じ admin プロセスで呼ぶ。アダプタは配らず、`deploy-adapters` の実行を案内する文を返す |
| `aegis_list_proposals` | admin・ssa | `status`、`limit`（最大 100、既定 20）、`offset` | 提案の一覧 |
| `aegis_get_proposal` | admin・ssa | `proposal_id` | 提案 1 件と根拠の Observation |
| `aegis_approve_proposal` | admin・ssa | `proposal_id`、`modifications` | 提案を承認して Canonical に反映する |
| `aegis_reject_proposal` | admin | `proposal_id`、`reason` | 提案を却下し、根拠の Observation を再分析できる状態に戻す |
| `aegis_preflight_proposal_bundle` | admin | `bundle_id` | 同じ `bundle_id` の pending 提案をまとめて承認できるかを、書き込まずに確かめる |
| `aegis_approve_proposal_bundle` | admin | `bundle_id` | 同じ `bundle_id` の pending 提案を 1 トランザクションで全部承認する（全部か無しか） |
| `aegis_check_upgrade` | admin | なし | テンプレートの新しい版の有無を調べる |
| `aegis_apply_upgrade` | admin | なし | テンプレートの更新を提案として作る |
| `aegis_archive_observations` | admin・ssa | `days`（既定 90） | 解決済みの古い Observation をアーカイブする |
| `aegis_get_stats` | admin・ssa | なし | 知識の件数・利用状況・健全性・プロジェクト共有の状態を返す |
| `aegis_list_observations` | admin | `event_type`、`outcome`（`proposed`・`skipped`・`pending`）、`limit`、`offset` | Observation を処理結果で絞って列挙する |
| `aegis_import_doc` | admin | `content` か `file_path`、`doc_id`、`title`、`kind`、`edge_hints`、`tags`、`source_path`、`source_refs` | 文書を取り込む Observation を記録し、続けて提案（`new_doc`・`add_edge`）を作って `proposal_ids` を返す。承認するまで Canonical は変わらない |
| `aegis_analyze_doc` | admin | 文書 1 件 | 取り込み計画（分割の候補・重複の警告・診断）を返す（読み取りのみ） |
| `aegis_analyze_import_batch` | admin | `items` | 複数文書の取り込み計画を返す（読み取りのみ） |
| `aegis_execute_import_plan` | admin | `import_plan` か `batch_plan`、`bundle_id` | 取り込み計画を提案のバンドルとして作る |
| `aegis_process_observations` | admin・ssa | `event_type` | 未分析の Observation を分析して提案を作る |
| `aegis_sync_docs` | admin・ssa | `doc_ids` ほか | `file-anchored` の文書をソースファイルと照合し、差があれば `update_doc` の提案を作る |

- `aegis_import_doc`・`aegis_analyze_doc`・`aegis_analyze_import_batch`・`aegis_execute_import_plan`・`aegis_process_observations`・`aegis_sync_docs` は、例外を本文 `<操作名>: <原因>`（例 `Sync failed: <原因>`）の `isError` 応答にして返す。原因の文字列は空にせず、スタックトレースは応答ではなく stderr に出す。
- MCP リソース `aegis://guide/workflow` で運用手順の文書を返す。
- MCP のツールにしない操作がある。アダプタの配布・一括承認・staleness の確定・共有バンドルの入出力は CLI だけで行う（「CLI のサブコマンドと終了コード」の節）。

## aegis_compile_context の引数

| 引数 | 既定値 | 意味 |
|---|---|---|
| `target_files` | 必須 | 編集する予定のファイルパスの配列 |
| `target_layers` | なし | 層を明示する（省略時は `layer_rules` でパスから決める） |
| `command` | なし | 操作の種別（`scaffold`・`refactor`・`review` など）。`command_requires` のエッジと、テンプレートの配り方に効く |
| `plan` | なし | 作業の自然言語の説明。関連度（`relevance`）の計算と、SLM による意図タグの推定に使う |
| `intent_tags` | なし | `aegis_get_known_tags` の一覧から選んだタグ。`[]` は拡張コンテキストを要らないという宣言で、SLM も呼ばない |
| `max_inline_bytes` | 131072 | インラインで返す本文の合計の上限（UTF-8 のバイト数） |
| `content_mode` | `auto` | `auto`・`always`・`metadata`（「delivery の割り当て規則」の節） |
| `include_debug` | `false` | 応答に `debug_info`（層の判定・予算で落とした文書・一致しなかったエッジ）を含める。同じ情報は常に `compile_log.audit_meta` に残る |
| `min_relevance` | 0 | 0〜1。`relevance` があり、この値未満の文書を応答から外す。`relevance` の無い文書は外さない |
| `agent_id` | なし | 呼び出し側の自己申告の識別子。`compile_log` に記録し、出力には影響しない |

## aegis_compile_context の出力

文書の選び方は次の順で、すべて承認済み（`approved`）のエッジと文書だけを使う。

1. `path_requires`: `target_files` のいずれかが glob に一致したエッジの文書。
2. `layer_requires`: 対象の層に結び付いた文書。
3. `command_requires`: `command` を指定したときだけ、その操作に結び付いた文書。
4. `doc_depends_on`: ここまでで選んだ文書の依存先を推移的にすべて足す。

- 文書は具体性（specificity）の降順、優先度（priority）の昇順、`doc_id` の順に並べる。
- `kind` が `template` の文書は `base.templates` に分ける。
- `relevance` は `plan` を渡したときだけ付く。`plan` の語のうち文書に現れる語の割合で、小数 2 桁に丸める。
- 拡張コンテキスト（`expanded`）は、`intent_tags` を渡したときはそのタグだけで、`tag_mappings` から文書を引く。未知のタグは警告を付けて捨てる。`intent_tags` を省略し、`plan` があり、SLM が有効なときだけ SLM がタグを推定する。SLM の失敗は警告になり、エラーにはならない。

応答の形は次のとおりである。

```json
{
  "schema_version": 2,
  "compile_id": "...",
  "snapshot_id": "...",
  "knowledge_version": 12,
  "base": {
    "documents": ["ResolvedDoc"],
    "resolution_path": ["..."],
    "templates": ["ResolvedDoc"]
  },
  "expanded": {
    "documents": ["ResolvedDoc"],
    "confidence": 0.0,
    "reasoning": "...",
    "resolution_path": []
  },
  "warnings": ["..."],
  "notices": ["..."],
  "debug_info": {}
}
```

- `expanded` は拡張コンテキストを計算したときだけ、`debug_info` は `include_debug: true` のときだけ付く。
- `ResolvedDoc` は `doc_id`・`title`・`kind`・`delivery`・`content_bytes`（常に付く）・`content_hash`（SHA-256、常に付く）・`content`（`delivery` が `inline` のときだけ）・`source_path`（DB にあれば `delivery` によらず付く）・`omit_reason`（`omitted` のとき）・`relevance` を持つ。
- `warnings` は同じ入力と同じ `knowledge_version` に対して同じ内容になる。時刻や DB の運用状態に依存する情報は `notices` に入れる（「notices の種類」の節）。
- `compile_log` への記録は、予算超過で失敗したときも行う。
- インラインで必ず返す文書（`source_path` の無い文書）の合計が `max_inline_bytes` を超えると、`isError` の応答で `{"error": "BUDGET_EXCEEDED_MANDATORY", "compile_id", "message", "mandatory_bytes", "max_inline_bytes", "offending_doc_ids"}` を返す。`offending_doc_ids` は大きい順である。

## delivery の割り当て規則

各文書の `delivery` は `inline`（本文を含める）・`deferred`（本文を含めず、呼び出し側が `source_path` を読む）・`omitted`（含めない）のいずれかで、次の順に決める。

1. テンプレートは、`content_mode` が `always` でなく、`command` が `scaffold` でもなければ `omitted`（`omit_reason: "policy:non_scaffold_command"`）にする。この判定は `source_path` の有無より先に行う。
2. `source_path` の無い文書は常に `inline` にする。その合計が予算を超えたら `BUDGET_EXCEEDED_MANDATORY` で失敗する。
3. `source_path` のある文書は、`always` なら `inline` の候補、`metadata` なら `deferred` にする。`auto` なら本文が 4096 バイト以下のとき `inline` の候補、それより大きければ `deferred` にする。
4. `inline` の候補を「テンプレート → 通常の文書 → 拡張コンテキストの文書」、同じ区分の中では `relevance` の降順（無いものは最後）、priority の昇順、`doc_id` の昇順に並べ、残りの予算に収まるものから採る。収まらない文書は `deferred` に回し、次の文書の判定を続ける。

- 予算の超過で `omitted` になる文書は無い。`omitted` はテンプレートの方針による省略だけで生じる。
- 文書の本文を途中で切ることはない。

## notices の種類

`notices` は次の順に並ぶ。いずれも時刻や運用状態に依存するので、決定性（P-1）の対象外である。

1. アダプタの版が古い（「DB の場所と待機モード」の節）。
2. プロジェクト共有の状態が `bundle_newer`・`local_ahead`・`diverged`・`unreadable_bundle` のとき、`[project-share] ...` の案内。`not_configured` と `in_sync` では出さない。
3. pending の提案の件数。
4. 未分析と skip の Observation の合計が 5 件以上のときの案内。
5. reconcile の滞留。今回返す文書のうち `file-anchored` のものが対象である。`hash-sync`・`anchor-sync` の文書は、最後の同期（`source_synced_at`）から 90 日以上たった、または同期の記録が無いときに 1 文書ずつ出す。`anchor-sync` の文書で anchor の解決に失敗した Observation が未解決のものも 1 文書ずつ出す。`semantic-review` の文書は件数でまとめて 1 つ出す。
6. `min_relevance` で外した文書の件数。

## aegis_observe のイベント種別

`event_type` は 7 種で、種別ごとに `payload` を検証し、不足があれば記録せずにエラーにする。

| event_type | 必須の項目 | 分析で作る提案 |
|---|---|---|
| `compile_miss` | `related_compile_id`、`related_snapshot_id`、`payload.target_files`（空でない）、`payload.review_comment`。任意で `target_doc_id`（`base.documents` の doc_id）、`missing_doc` | `missing_doc` があれば `add_edge`。`target_doc_id` だけなら提案を作らない |
| `review_correction` | `payload.file_path`、`payload.correction`。`target_doc_id` と `proposed_content` は両方そろえるか両方省く | 両方あれば `update_doc` |
| `pr_merged` | `payload.pr_id`、`payload.summary`、`payload.files_changed`（空でない） | エッジで覆われていないパスへの `add_edge` |
| `manual_note` | `payload.content`。`target_doc_id` と `proposed_content` は両方そろえる。`new_doc_hint` には `doc_id`・`title`・`kind` | ヒントに応じて `update_doc` か `new_doc` |
| `document_import` | `content`、`doc_id`（`/^[a-z0-9][a-z0-9_-]*$/`）、`title`、`kind` | `new_doc` と `add_edge`（通常は `aegis_import_doc` が記録する） |
| `doc_gap_detected` | `gap_kind`、`metrics`、`algorithm_version` ほか | 作らない（診断の記録） |
| `staleness_detected` | `doc_id`、`level`（1〜3）、`kind`、`detail`、`algorithm_version` | 作らない（診断の記録） |

- `compile_miss` の応答には、トリアージの手順を示す文が付く。
- `kind` に使える値は `guideline`・`pattern`・`constraint`・`template`・`reference` である。

## CLI のサブコマンドと終了コード

`npx @fuwasegu/aegis <サブコマンド>`（または `node dist/main.js <サブコマンド>`）で実行する。CLI は admin と同じ権限で動く。`--db` を省くと `<project-root>/.aegis/aegis.db` を使い、`--project-root` を省くとカレントディレクトリを使う。

| コマンド | 引数 | 振る舞い |
|---|---|---|
| `deploy-adapters` | `--project-root`、`--targets <a,b>`（`cursor`・`claude`・`codex`。省略時は全部）、`--db` | IDE 向けのルールとスキルを配る（「永続ファイル」の節）。DB ファイルが無ければ 1。結果に `conflict`・`failed` があっても 0。全対象に配り、失敗も衝突も無いときだけ `adapter_meta` に版を記録する |
| `maintenance` | `--dry-run`、`--days <N>`（既定 90）、`--project-root`、`--db`、`--templates`、`--template-dir` | Observation の分析、文書の同期、アーカイブ、テンプレートの更新確認、co-change のキャッシュ、staleness の検査、DB の圧縮を順に行い、6 つの節の要約を出す。DB ファイルが無い・`--days` が正の整数でなければ 1。`--dry-run` でなく、Observation の分析に失敗が 1 件でもあれば 1。それ以外は 0 |
| `approve-pending` | `--dry-run`、`--types <t1,t2>`、`--project-root`、`--db`、`--templates`、`--template-dir` | pending の提案を一括で承認する（「フォーク固有の振る舞い」の節）。stdout に JSON 1 つ、stderr に要約 1 行。完了で 0、承認の失敗を含むと 1、引数の誤り・DB ファイルが無い・例外は 2 |
| `staleness-ack` | `--doc-ids <a,b>` か `--all`（どちらか 1 つが必須）、`--dry-run`、`--project-root`、`--db`、`--templates`、`--template-dir` | 文書の Level 3 の基準値を現在のファイルから取り直し、その文書の Level 3 の `staleness_detected` をアーカイブする。stdout に JSON 1 つ。完了で 0、引数の誤り・未知または未承認の `doc_id`・DB ファイルが無い・例外は 2 |
| `stats` | `--project-root`、`--db`、`--templates`、`--template-dir` | 件数・利用状況・健全性・`project_share` を JSON で出す。DB ファイルが無ければ 1、それ以外は 0 |
| `doctor` | `stats` と同じ | 健全性を人が読む形で出す。古い文書・未分析の Observation・孤立したタグの対応がある、または共有の状態が `bundle_newer`・`local_ahead`・`diverged`・`unreadable_bundle` なら 1。問題が無ければ `Status: OK` を出して 0。DB ファイルが無ければ 1 |
| `share-export` | `--project-root`、`--db`、`--out <DIR>`（既定 `<root>/aegis-share`） | 承認済みの Canonical を `manifest.json` と `canonical.json` に書き出す。DB ファイルが無い・失敗は 1 |
| `share-hydrate` | `--project-root`、`--db`、`--bundle-dir <DIR>`（既定 `<root>/aegis-share`）、`--replace` | バンドルから DB を丸ごと作り直す。初期化済みの DB を置き換えるには `--replace` が要る。手元の Observation・提案・`compile_log` は残らない。DB ファイルが無くても動く。失敗は 1 |
| `share-lint` | `--project-root`、`--source-dir <DIR>`（既定 `aegis-share/source`） | 共有ソースを検査する。エラーがあれば 1。フラグの値が無ければ 1 |
| `share-format` | `share-lint` と同じ | 共有ソースの書式をその場で決定的に整える。失敗は 1 |
| `share-materialize` | `--project-root`、`--db`、`--source-dir`、`--dry-run` | 共有ソースと DB の差を適用し、同じ実行の中で承認する。DB ファイルが無い・失敗は 1 |
| `share-source-export` | `--project-root`、`--db`、`--out <DIR>`（既定 `aegis-share/source`） | 現在の DB を共有ソースの形式で書き出す。DB ファイルが無い・失敗は 1 |

- `maintenance` の要約の節は `process_observations`・`sync_docs`（staleness の報告を含む）・`archive`・`check_upgrade`・`co_change_cache`・`db_compaction` の 6 つである。`--dry-run` では Observation の分析を飛ばし、基準値を書かず、`VACUUM` も実行しない。
- `stats` と `doctor` は DB を開くだけで、`source_path` の正規化の移行は行わない。ただし DB を開くときにスキーマの移行が必要なら、その分は書き込む。
- `approve-pending` と `staleness-ack` は未知のオプションと値の無いオプションを引数の誤りとして扱う。ほかのサブコマンドは未知のオプションを無視する。

## 環境変数一覧

| 変数 | 既定値 | 効果 |
|---|---|---|
| `AEGIS_SNAPSHOT_RETENTION` | 20 | 内容行を残す snapshot の世代数。正の整数（先頭が 0 でない 10 進数で、安全な整数の範囲）でなければ警告を 1 度出して 20 を使う |
| `GIT_DIR`・`GIT_WORK_TREE` などの git の環境変数 | なし | staleness の検査で `git ls-files` を呼ぶとき、子プロセスの環境から取り除く。あわせて `GIT_OPTIONAL_LOCKS=0` を設定する |

- `AEGIS_SNAPSHOT_RETENTION` と git の環境変数のほかに、aegis が読む環境変数は無い。SLM と Ollama の設定はすべて起動引数で行う。

## 永続ファイル

| 内容 | パス | 形式 |
|---|---|---|
| DB | `<project-root>/.aegis/aegis.db`、または `--db` のパス | SQLite（sql.js で読み書きする） |
| DB のロック | `<DB のパス>.lock` | 排他作成するロックファイル。30 秒より古いものは捨てる |
| 書き込み中の一時ファイル | `<DB のパス>.tmp-<pid>` | 書き終えたら DB へ rename する。異常終了で残ったものは、次に DB を開くとき 30 秒より古ければ消す |
| DB ディレクトリの除外設定 | DB の親ディレクトリの `.gitignore` | 内容 `*`。MCP サーバーが DB ファイルを開くとき、無ければ作る |
| SLM のモデル | `~/.aegis/models/` | GGUF。全プロジェクトで共有 |
| 共有バンドル | `aegis-share/manifest.json`、`aegis-share/canonical.json` | 決定的な JSON。git に入れて共有する |
| 共有ソース | `aegis-share/source/documents/<doc_id>.md`、`aegis-share/source/edges/{path-requires,layer-requires,command-requires,doc-depends-on}.json`、`aegis-share/source/layer-rules.json`、`aegis-share/source/tag-mappings.json` | 文書は frontmatter（`doc_id`・`title`・`kind`・`ownership`・`source_path`・`source_refs_json`・`template_origin`）付きの Markdown |
| Claude Code 向けのルール | `CLAUDE.md` の `<!-- aegis:start -->` から `<!-- aegis:end -->` まで | 管理ブロックだけを書き換える。ファイルが無ければ作る |
| Codex 向けのルール | `AGENTS.md` の同じ目印の間 | `CLAUDE.md` と同じ |
| Cursor 向けのルール | `.cursor/rules/aegis-process.mdc` | 目印 `<!-- aegis:managed -->` 付きの専用ファイル |
| スキル | `.claude/skills/<名前>/SKILL.md`、`.codex/skills/<名前>/SKILL.md`、`.cursor/skills/<名前>/SKILL.md`（名前は `aegis-bulk-import`・`aegis-setup`・`aegis-triage`） | 目印 `<!-- aegis:managed-skill -->` 付き。目印の無い既存ファイルは上書きせず `conflict` にする |

- `.aegis/` は手元の実行時の状態（Observation・提案・`compile_log`）を含むので共有しない。共有するのは `aegis-share/` である。

## フォーク固有の振る舞い

このフォークで上流に足した振る舞いである。設計の理由は `docs/plan.md` と ADR-019 にある。

- 未導入のプロジェクトでは待機モードで起動する（「DB の場所と待機モード」の節）。
- `approve-pending` は pending の提案を `bootstrap → new_doc → update_doc → add_edge → retarget_edge → remove_edge → deprecate → materialize` の順（同じ種別の中は作成順）に、1 件ずつ別のトランザクションで承認する。途中で失敗しても成功した承認は残る。
  - `bundle_id` のある提案は承認せず `reason: "bundled"` で `skipped` に入れる。
  - 同じ文書への `update_doc` が複数あるときは、最新の 1 件だけを候補にし、古いものを `reason: "superseded"` で却下する。最新の 1 件も、本文がソースファイルの全体と一致しなければ `reason: "stale_content"` で却下する。ソースファイルの無い文書は比較せずに承認する。
  - 処理中に pending でなくなった提案は `reason: "no_longer_pending"` で `skipped` に入れ、失敗に数えない。
  - 出力の JSON は `approved`・`would_approve`・`rejected`・`would_reject`・`skipped`・`failed` を持つ。`--dry-run` では書き込まない。
  - MCP のツールとしては公開しない。
- `staleness-ack` は、コードの変化による Level 3 の指摘（`symbol_drift` など）を、人が確かめた後に確定する。出力の JSON は `dry_run`・`acknowledged`（種別ごとの Level 3 の指摘数と、新しい基準値のパス数）・`skipped`（`reason: no_linked_paths | source_unreadable`）・`archived_observations` を持つ。Level 1 と Level 2 には効かない（`aegis_sync_docs` で解消する）。
- staleness の検査対象のファイルは `git ls-files --cached --others --exclude-standard -z` で列挙する（追跡ファイルと、ignore されていない未追跡ファイル）。git が無い、作業ツリーの外である、またはプロジェクトルート自体が外側のリポジトリで ignore されているときは、ディレクトリの再帰走査に切り替える（`.git`・`node_modules`・`dist`・`coverage`・`.turbo`・`target`・`out`・`.next`・`build` を飛ばす）。作業ツリーの中で `git ls-files` 自体が失敗したときは、走査に切り替えず `maintenance` を失敗させる。要約には `scan: <n> file(s) listed via git|walk, <n> fingerprint(s) computed` を出す。
- 承認で文書の `path_requires`（パスを起点とするもの）のエッジが変わると、その文書の Level 3 の基準値を消し、Level 3 の `staleness_detected` をアーカイブする。次の `maintenance` で基準値を取り直す。
- snapshot は最新の 20 世代（`AEGIS_SNAPSHOT_RETENTION`）と、`compile_log`・Observation・初期化の記録から参照される世代の内容行だけを残し、それ以外の世代の内容行を消す。世代の見出しの行は残す。
- `maintenance` の最後の `db_compaction` は、DB の空き領域が 1 MiB 以上かつファイルの 25% 以上のときだけ `VACUUM` を実行する。`--dry-run` では判定だけを出す。
- 取り込み・分析・同期の 6 つの管理用ツールは、エラー応答に原因の文字列を必ず含める（「サーフェスとツール一覧」の節）。

## 参照ドキュメント一覧

本書はすべてコードから起こした（2026-11-01、コミット d784bef の時点。「DB の場所と待機モード」の節は 003-dormant-mode の実装時点）。README と `docs/technical-guide.ja.md` は照合にだけ使い、食い違う箇所はコードに従った。

| 資料 | 参照した目的 |
|---|---|
| `src/main.ts` | 起動引数・DB の場所と待機モードの判定（`src/core/init/install-marker.ts`）・CLI のサブコマンドと終了コード |
| `src/core/init/install-marker.ts` | 導入済みの目印の判定・起動モード・待機モードの文言 |
| `src/mcp/server.ts`・`src/mcp/services.ts`・`src/mcp/tool-error.ts` | ツールの登録・引数・サーフェスの検査・Observation の検証・エラー応答 |
| `src/core/read/compiler.ts`・`src/core/read/allocator.ts`・`src/core/types.ts` | compile の選び方・出力の形・delivery・notices |
| `src/core/store/database.ts`・`src/core/store/snapshot-pruning.ts` | DB ファイル・ロック・一時ファイル・snapshot の保持と圧縮 |
| `src/core/optimization/staleness.ts`・`src/core/optimization/repo-file-listing.ts`・`src/core/optimization/staleness-ack.ts`・`src/core/automation/approve-pending.ts` | フォーク固有の振る舞い |
| `src/core/source-sync-staleness.ts`・`src/core/project-share/`・`src/adapters/`・`src/expansion/models.ts` | reconcile の notices・共有ファイル・アダプタの配布先・モデル |
| `package.json` | パッケージ名・版・Node.js の要件 |
| `docs/adr/019-operations-lightening.md` | フォーク固有の振る舞いの決定の範囲 |
| `docs/adr/020-ssa-surface.md` | ssa サーフェスのツールの集合とサービス層の許可 |
