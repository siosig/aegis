---
description: "aegis（このフォーク）の現行の外部仕様（MCP サーバーの起動引数、DB の場所と待機モード、サーフェスごとのツール、aegis_compile_context の入出力、CLI のサブコマンドと終了コード、環境変数、永続ファイル、フォーク固有の振る舞い）。ツールや CLI の挙動を変える・呼び出し方を確かめる・既定値を調べるときに読む。"
updated: 2026-11-01
keywords: [aegis, MCP, surface, agent, admin, ssa, compile_context, delivery, notices, CLI, exit code, 終了コード, maintenance, approve-pending, staleness-ack, edges, resolve, import-doc, init-confirm, approve-proposal, admin CLI, share-export, share-hydrate, share-materialize, .aegis, aegis.db, in-memory, 未導入, dormant, 待機モード, CLAUDE.md, AEGIS_SNAPSHOT_RETENTION]
---
# aegis 仕様

## 概要（簡潔に）

- aegis は、編集対象のファイルパスから DAG（パスと文書を結ぶエッジ）をたどり、AI エージェントに渡す文書の集合を決定的に返す MCP サーバー（stdio）である。パッケージは `@fuwasegu/aegis` 版 1.1.0、入口は `dist/main.js`、Node.js 26 以上を要する。
- MCP のツールは 3 つのサーフェスに分かれる。`agent` サーフェスは 6 ツール、`ssa` サーフェスは agent の 6 ツールに 6 ツールを足した 12 ツール、`admin` サーフェスは agent の 6 ツールに管理用の 18 ツールを足した 24 ツールを登録する（`agent` ⊂ `ssa` ⊂ `admin`）。ただし、プロジェクトに導入の目印が無く `--db` も無いときは待機モードで起動し、サーフェスによらず 2 ツール（`aegis_init_detect`・`aegis_workspace_status`）だけを登録する。
- 知識の正本（Canonical Knowledge）は SQLite の DB にある。MCP サーバーは、`--db` を明示したとき、または導入の目印（プロジェクトルートの `CLAUDE.md` の `aegis: 導入済み` を含む行、または `.aegis`）があるときだけ DB ファイルを開く・作る。どちらでもなければ待機モードで動き、空のインメモリ DB を使い、ファイルを作らず、「未導入」を stderr と `aegis_workspace_status` の応答で知らせる。
- 第 1 引数がサブコマンド名なら MCP サーバーではなく CLI として動く（`deploy-adapters`・`maintenance`・`approve-pending`・`staleness-ack`・`edges`・`resolve`・`stats`・`doctor`・`share-*`、および admin の操作の `import-doc`・`analyze-import-batch`・`execute-import-plan`・`init-confirm`・`apply-upgrade`・`reject-proposal`・`preflight-proposal-bundle`・`approve-proposal-bundle`・`approve-proposal`）。
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

`agent` の 6 ツールは 3 つのサーフェスすべてに登録する。`aegis_list_proposals`・`aegis_get_proposal`・`aegis_archive_observations`・`aegis_get_stats`・`aegis_process_observations`・`aegis_sync_docs` の 6 ツールは `ssa` と `admin` に、`aegis_approve_proposal` を含む残りの管理用の 12 ツールは `admin` にだけ登録する。`ssa` から提案は承認できないので、承認は CLI の `approve-proposal` か `admin` で行う。サービス層でも、`agent` はすべての管理用の操作を、`ssa` は `SSA_ALLOWED_OPERATIONS`（上の 6 ツールが使う操作と、それらが内部で呼ぶ `analyzeAndPropose`）以外の操作を `SurfaceViolationError` で拒否する（ADR-020）。

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
| `aegis_approve_proposal` | admin | `proposal_id`、`modifications` | 提案を承認して Canonical に反映する |
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
| `import-doc` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_import_doc` を実行する。文書を取り込み、提案を作る。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、引数の誤り・DB ファイルが無い・サービス層の例外は 2 |
| `analyze-import-batch` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_analyze_import_batch` を実行する。取り込み計画を分析する（読み取り専用）。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、引数の誤り・DB ファイルが無い・サービス層の例外は 2 |
| `execute-import-plan` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_execute_import_plan` を実行する。分析した取り込み計画を提案のバンドルにする。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、引数の誤り・DB ファイルが無い・サービス層の例外は 2 |
| `init-confirm` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_init_confirm` を実行する（事前に `aegis_init_detect` と同じ検出を行う）。DB ファイルが無ければ作る。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、引数の誤り・`preview_hash` の不一致などの事前の検出の不合格・サービス層の例外は 2 |
| `apply-upgrade` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_apply_upgrade` を実行する。テンプレートの更新の提案を作る。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、引数の誤り・DB ファイルが無い・サービス層の例外は 2 |
| `reject-proposal` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_reject_proposal` を実行する。提案を却下する。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、引数の誤り・DB ファイルが無い・サービス層の例外は 2 |
| `preflight-proposal-bundle` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_preflight_proposal_bundle` を実行する。バンドルの承認前の検査（読み取り専用）。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、`ok` が `false` なら 1。引数の誤り・DB ファイルが無い・サービス層の例外は 2 |
| `approve-proposal-bundle` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_approve_proposal_bundle` を実行する。バンドルを承認する。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、引数の誤り・DB ファイルが無い・サービス層の例外は 2 |
| `approve-proposal` | `--input <path\|->`、`--project-root`、`--db`、`--templates`、`--template-dir` | `aegis_approve_proposal` を実行する。提案を 1 件承認する。入力は JSON で、詳細は「admin の操作の CLI」の小節。stdout に JSON 1 つ。完了で 0、引数の誤り・DB ファイルが無い・サービス層の例外は 2 |
| `edges` | `--json`（必須）、`--project-root`、`--db` | 承認済みのエッジの全件を、対象文書の `source_path` 付きで JSON 1 つにして stdout に出す（出力は「edges と resolve の出力」の小節）。読み取り専用。完了で 0、引数の誤り・DB ファイルが無い・例外は 2 |
| `resolve` | `<path>...`（1 つ以上）、`--json`（任意・意味なし）、`--project-root`、`--db`、`--`（これより後はすべてパス） | パスごとに `aegis_compile_context` の base が配る文書と経路を JSON 1 つにして出す。読み取り専用。終了コードは `edges` と同じ |
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
- `edges` と `resolve` も `source_path` の正規化の移行を行わない（古い DB の絶対パスの `source_path` はそのまま出る）。DB とその隣のファイルに一切書かず、ロックも取らない。移行が要る古い DB でも移行はメモリ上だけで行う。
- `approve-pending`・`staleness-ack`・`edges`・`resolve` と admin の操作の 9 つ（`import-doc`・`analyze-import-batch`・`execute-import-plan`・`init-confirm`・`apply-upgrade`・`reject-proposal`・`preflight-proposal-bundle`・`approve-proposal-bundle`・`approve-proposal`）は未知のオプションと値の無いオプションを引数の誤りとして扱う。ほかのサブコマンドは未知のオプションを無視する。`edges`・`resolve` と admin の操作の 9 つは `--opt=value` の形も受け付け、`-` で始まる値は `--db=-foo` の形でだけ渡せる（`--db -foo` は値の無いオプションとして誤りになる）。

### admin の操作の CLI

admin だけの MCP ツール 9 本に当たるサブコマンドである。入力は MCP のツールと同じ JSON オブジェクト、出力は stdout の JSON 1 つ、失敗は終了コードで返す。CLI はサーフェスを持たず、admin の権限で動く。未知のサブコマンドは従来どおり MCP サーバーとして起動する。ssa の `bin/aegis` の許可の一覧には、この 9 つの名前を足す。

#### サブコマンドと MCP ツールの対応

| サブコマンド | 対応する MCP ツール | 入力の項目（MCP と同じ名前・型） |
|---|---|---|
| `import-doc` | `aegis_import_doc` | `doc_id`・`title`・`kind`（必須）、`content`・`file_path`・`edge_hints`・`tags`・`source_path`・`source_refs` |
| `analyze-import-batch` | `aegis_analyze_import_batch` | `items`（必須） |
| `execute-import-plan` | `aegis_execute_import_plan` | `import_plan`・`batch_plan`・`bundle_id` |
| `init-confirm` | `aegis_init_detect` → `aegis_init_confirm` | `preview_hash`（必須）、`project_root`、`skip_template` |
| `apply-upgrade` | `aegis_apply_upgrade` | なし（`{}`） |
| `reject-proposal` | `aegis_reject_proposal` | `proposal_id`・`reason`（必須） |
| `preflight-proposal-bundle` | `aegis_preflight_proposal_bundle` | `bundle_id`（必須） |
| `approve-proposal-bundle` | `aegis_approve_proposal_bundle` | `bundle_id`（必須） |
| `approve-proposal` | `aegis_approve_proposal` | `proposal_id`（必須）、`modifications` |

- `--input <path>` は入力の JSON オブジェクトをファイル（カレントディレクトリ基準の相対パス可）から、`--input -` は stdin から読む。省略すると `{}` を入力とする。`-` で始まるファイル名は `--input=-name.json` の形で渡す。
- `--project-root`（既定はカレントディレクトリ）は `source_path` の正規化の基準と `--db` の既定の場所に使う。`--db` の既定は `<project-root>/.aegis/aegis.db`。`--templates`（既定はパッケージの `templates/`）と `--template-dir`（複数回指定できる）は `aegis_init_detect` と `apply-upgrade` が使うテンプレートの置き場である。
- MCP サーバーの起動のオプション（`--surface`・`--slm` 等）は受け付けない（未知のオプションとして誤りになる）。位置引数・空文字列の値も引数の誤りである。
- `import-doc` の `file_path` と `analyze-import-batch` の `items[].file_path` は MCP と同じに解釈する（サービス層がそのまま読むので、絶対パスを渡す）。

#### 入力の検証（admin の操作）

- 入力は JSON オブジェクト 1 つでなければならない。JSON として読めない・オブジェクトでない・必須の項目が無い・型が違うときは引数の誤り（終了コード 2）で、DB を開かない。
- 検証には MCP のツールと同じ zod のスキーマ（`src/mcp/tool-input-schemas.ts`）を使うので、既定値などの変換も MCP と同じに働く。
- MCP との差は未知のキーの扱いだけである。最上位の未知のキーは CLI では引数の誤り（終了コード 2）で、MCP では無視される。入れ子の要素（`edge_hints`・`source_refs`・`items` の要素）の未知のキーは、どちらでも無視される。

#### 出力と終了コード（admin の操作）

- 成功（終了コード 0・1）では、stdout にサービス層の戻り値を `JSON.stringify(result, null, 2)` にして改行 1 つを付けて出す。内容は admin の MCP のツールが返す JSON（解析した値）と同じである。
- `init-confirm` は、MCP の応答が JSON の後に付ける `Next: run ... deploy-adapters` の案内を出さない。初期化の後は必要に応じて `deploy-adapters` を実行する。
- 終了コード 0 では stderr に何も出さない。失敗（終了コード 2）では stdout に何も出さず、stderr に 1 行を出す（スタックは出さない）。

| 失敗 | stderr の行 |
|---|---|
| 引数の誤り | `[aegis] <サブコマンド>: <理由>` |
| 入力のファイルが読めない | `[aegis] <サブコマンド>: cannot read --input <path>: <理由>` |
| 入力が JSON でない | `[aegis] <サブコマンド>: invalid input: not valid JSON (<理由>)` |
| 入力の検証の失敗 | `[aegis] <サブコマンド>: invalid input: <項目のパス>: <理由>; ...` |
| DB ファイルが無い | `[aegis] Database not found at <dbPath>` |
| サービス層の例外 | `[aegis] <サブコマンド>: <例外の message（改行は空白 1 つ）>` |

| 終了コード | 条件 |
|---|---|
| 0 | 操作が完了した。`import-doc` の `warnings`、`execute-import-plan` の `skipped_duplicate_count`、`apply-upgrade` の空の `proposal_ids`、`analyze-import-batch` の重なりの警告があっても 0 |
| 1 | `preflight-proposal-bundle` の結果の `ok` が `false`。stdout に JSON を出し、stderr に `[aegis] preflight-proposal-bundle: ok=false bundle_id=<id>`（`ordering_error` があれば ` ordering_error=<文>` を続ける）を出す |
| 2 | 引数の誤り・DB ファイルが無い・サービス層の例外（存在しない・pending でない提案、バンドルの承認の失敗、`preview_hash` の不一致、初期化済み、許されない `modifications` の項目など） |

- 終了は `process.exitCode` で返し、`process.exit()` を呼ばない（ADR-019 D-3）。

#### DB ファイルの扱い（admin の操作）

- `init-confirm` 以外は、DB ファイルが無ければ終了コード 2 で、DB もディレクトリも作らない。
- `init-confirm` は、DB ファイルが無ければ、DB を作る前に `aegis_init_detect` と同じ検出を行い、`preview_hash` の一致と、確定を妨げる警告（`has_blocking_warnings`）が無いことを確かめる。不合格なら何も作らずに終了コード 2 を返す。合格したら DB の親ディレクトリと `.gitignore`（中身 `*`。既にあれば変えない）を作り、DB を作って確定する。
- 書き込みは既存の DB の書き込みの規則（ロック・一時ファイルと rename による置き換え）に従う。
- `source_path` の正規化の移行は行わない（`approve-pending`・`staleness-ack` と同じ）。

#### init-confirm の手順

1. `aegis_init_detect` を `{ project_root, skip_template }` で呼び、プレビューを確かめて `preview_hash` を控える（どのサーフェスでも、待機モードでも呼べる）。
2. `init-confirm` に `{ preview_hash, project_root, skip_template }` を渡す。`project_root` を省くと `--project-root` を使う。
3. CLI は同じ実行の中で検出をやり直し、`preview_hash` が一致したときだけ確定する。`preview_hash` は `project_root`・`skip_template`・テンプレート（`--templates`・`--template-dir`）とプロジェクトのファイルに依存するので、1 と同じ値を渡し、その間にプロジェクトを変えない。一致しなければ終了コード 2 で確定しない。
4. 結果は `aegis_init_confirm` と同じ `{ knowledge_version, snapshot_id }` である。

### edges と resolve の出力

どちらも stdout に JSON を 1 つ、2 空白の字下げで出し、最後に改行を 1 つ付ける。成功のとき stderr には何も出さない。終了コード 1 は使わない。位置引数・上の表にないオプションは引数の誤りである（`resolve` のパスを除く）。`edges` は `--json` が無ければ引数の誤りで、人が読む形の出力は無い。

#### edges

```json
{
  "schema_version": 1,
  "knowledge_version": 98,
  "edges": [
    {
      "edge_id": "8b96c554-b619-431f-8377-8dfa263637bb",
      "edge_type": "path_requires",
      "source_type": "path",
      "source_value": "src/core/read/**",
      "target_doc_id": "adr-009-compile-context-output-size-control",
      "source_path": "docs/adr/009-compile-context-output-size-control.md",
      "priority": 100,
      "specificity": 0
    }
  ]
}
```

| フィールド | 型 | 内容 |
|---|---|---|
| `schema_version` | 整数 | この形の版。現在は 1 |
| `knowledge_version` | 整数 | `knowledge_meta.current_version`。未初期化の DB では 0 |
| `edges`（トップレベルのキー） | 配列 | 承認済みのエッジ。0 件なら `[]` |
| `edges[].edge_id` | 文字列 | エッジの ID |
| `edges[].edge_type` | 文字列 | `path_requires`・`layer_requires`・`command_requires`・`doc_depends_on` |
| `edges[].source_type` | 文字列 | `path`・`layer`・`command`・`doc` |
| `edges[].source_value` | 文字列 | パターン（パスの glob・レイヤー名・コマンド名・依存元の doc_id） |
| `edges[].target_doc_id` | 文字列 | 対象文書の doc_id |
| `edges[].source_path` | 文字列か `null` | 対象文書の `source_path`。文書の状態（承認済みか）を問わず引く。無ければ `null`。移行をしないので、古い DB の絶対パスはそのまま出る |
| `edges[].priority` | 整数 | エッジの優先度 |
| `edges[].specificity` | 整数 | エッジの具体性 |

- オブジェクトのキーは上の表の順に出す。
- 要素の並びは `edge_type` → `source_value` → `target_doc_id` → `edge_id` の昇順で、比較は UTF-8 のバイト列の順（SQLite の BINARY 照合）である。`edge_id` が一意なので、同じ DB の内容からは常に同じバイト列が出る（P-1）。
- 含めないもの: `draft`・`proposed`・`deprecated` のエッジ、pending の提案に含まれるエッジ（承認されるまで `edges` 表に無い）。対象文書が承認済みでなくても（`deprecated` 等）、エッジが承認済みなら出す。

#### resolve

渡したパスごとに、次の形の要素を `results` に渡した順で入れる（同じパスを 2 回渡せば 2 要素になる）。

```json
{
  "schema_version": 1,
  "knowledge_version": 98,
  "results": [
    {
      "path": "./src/core/paths.ts",
      "normalized_path": "src/core/paths.ts",
      "documents": [
        {
          "doc_id": "adr-009-compile-context-output-size-control",
          "source_path": "docs/adr/009-compile-context-output-size-control.md",
          "resolution_path": [
            {
              "edge_id": "801ddfe7-96a9-440c-8c5e-3a63e0fb86d1",
              "source_type": "path",
              "source_value": "src/core/paths.ts",
              "target_doc_id": "adr-009-compile-context-output-size-control",
              "edge_type": "path_requires"
            }
          ]
        }
      ],
      "resolution_path": [
        {
          "edge_id": "801ddfe7-96a9-440c-8c5e-3a63e0fb86d1",
          "source_type": "path",
          "source_value": "src/core/paths.ts",
          "target_doc_id": "adr-009-compile-context-output-size-control",
          "edge_type": "path_requires"
        }
      ]
    },
    {
      "path": "no/such/dir/x.txt",
      "normalized_path": "no/such/dir/x.txt",
      "documents": [],
      "resolution_path": []
    }
  ]
}
```

| フィールド | 型 | 内容 |
|---|---|---|
| `schema_version` | 整数 | この形の版。現在は 1 |
| `knowledge_version` | 整数 | `knowledge_meta.current_version`。未初期化の DB では 0 |
| `results` | 配列 | 入力のパスごとに 1 要素。渡した順に並べ、重複を除かない |
| `results[].path` | 文字列 | 入力の原文 |
| `results[].normalized_path` | 文字列 | 照合に使った値（下の「パスの正規化」） |
| `results[].documents` | 配列 | base が配る文書。一致が無ければ `[]` |
| `results[].documents[].doc_id` | 文字列 | 文書の doc_id |
| `results[].documents[].source_path` | 文字列か `null` | 文書の `source_path` |
| `results[].documents[].resolution_path` | 配列 | `results[].resolution_path` のうち、`target_doc_id` がこの文書のもの（元の順） |
| `results[].resolution_path` | 配列 | `aegis_compile_context` の `base.resolution_path` と同じ配列。要素は `edge_id`・`source_type`・`source_value`・`target_doc_id`・`edge_type` の順のキーを持つ |

`source_path` は、`resolve` では文書に無いとき `null` で出る。`aegis_compile_context` の `base.documents` では、無いときキー自体が出ない（`undefined`）。

#### パスの正規化（resolve）

照合の前に、各パスを次の順で字句的に正規化する（`normalizeTargetPath`）。ファイルシステムには触れず（存在しないパスも渡せる）、symlink は解かない。

1. 空文字列なら誤り（`path is empty`）。
2. `\` をすべて `/` に置き換える。
3. 絶対パス（実行中の OS の `path.isAbsolute`）なら、`--project-root` の絶対パスからの相対パスにし、OS の区切り文字を `/` にする。
4. POSIX の規則で `.`・`..`・重なった `/` を畳む（`path.posix.normalize`）。末尾の `/` を除く。
5. 結果が `.`（ルートそのもの）なら誤り（`path resolves to the project root: <入力>`）。
6. 結果が `..` か `../` で始まる（ルートの外）、または実行中の OS で絶対パスのまま（Windows で別のドライブのパスなど）なら誤り（`path is outside the project root: <入力>`）。

| 入力（`--project-root /work/proj`） | `normalized_path` |
|---|---|
| `src/main.ts` | `src/main.ts` |
| `./src/main.ts` | `src/main.ts` |
| `src\core\paths.ts` | `src/core/paths.ts` |
| `src//main.ts` | `src/main.ts` |
| `src/../docs/spec.md` | `docs/spec.md` |
| `docs/./a.md` | `docs/a.md` |
| `src/` | `src` |
| `/work/proj/src/main.ts` | `src/main.ts` |
| `/work/proj`・`/work/proj/`・`.`・`./` | 誤り（ルートそのもの） |
| `../x.ts`・`src/../../x.ts`・`/etc/passwd`・`/work/projX/a.ts` | 誤り（ルートの外） |
| （空文字列） | 誤り（空） |

- 照合（`aegis_compile_context` と同じ picomatch の既定のオプション）には `normalized_path` を使う。`aegis_compile_context` は `target_files` を正規化しないので、`./src/main.ts` や絶対パスを渡すと当たらない。`resolve` は正規化してから照合する点だけが違う。
- `\` は POSIX のファイル名に使える文字だが、エッジのパターンは `/` 区切りなので、常に区切り文字として扱う。
- symlink を解かないのは、エッジが git の追跡するリポジトリ上のパスを指し、`aegis_compile_context` もパスを字句のまま照合するからである。`--project-root` に symlink を含むパスを渡し、絶対パスを実体のパスで渡すと、ルートの外として誤りになる。

#### aegis_compile_context との一致（resolve、FR-006）

同じ DB に対して、`normalized_path` 1 つだけを `target_files` に渡し、`target_layers`・`command`・`plan`・`intent_tags` を渡さない `aegis_compile_context` を呼んだとき、次の 3 点が一致する。

- `results[].documents` の `doc_id` の並び = `base.documents` の `doc_id` の並び。
- `results[].documents[].source_path` = `base.documents` の同じ文書の `source_path`。
- `results[].resolution_path` = `base.resolution_path`。

照合の規則は `aegis_compile_context` と同じコード（`ContextCompiler.routeBase`）である。

1. `path_requires`: 承認済みのパスのエッジのうち、`source_value`（glob）が `normalized_path` に当たるもの。
2. `layer_requires`: 承認済みのレイヤーの規則で `normalized_path` のレイヤーを決め、そのレイヤーの承認済みのエッジ。
3. `command_requires`: 使わない（`resolve` は `command` を受け取らない）。
4. `doc_depends_on`: 1〜2 で集めた文書から、承認済みの依存のエッジをたどった閉包。
5. 承認済みの文書だけを残し、具体性の降順 → 優先度の昇順 → doc_id の順に並べ、`kind` が `template` の文書を除く（`aegis_compile_context` では `base.templates` に入る）。

出さないもの: `expanded`（`intent_tags`・SLM のタガー）、`base.templates`、`delivery`、`relevance`、`warnings`、`notices`、`compile_id`・`snapshot_id`。

差: `resolve` は delivery の割り当てをしないので、`source_path` の無い文書の合計が予算（既定 128KB）を超えて `aegis_compile_context` が `BudgetExceededError` で失敗する場合も、照合の結果を返す。

#### 未初期化の DB（resolve）

スナップショットが無い（`init_confirm` の前で `knowledge_version` が 0）とき、`aegis_compile_context` と同じく、すべてのパスの `documents` と `resolution_path` を `[]` にして終了コード 0 で返す。`edges` の `knowledge_version` も 0 になる。

#### 終了コードとエラー（edges と resolve）

| 状況 | 終了コード | stdout | stderr（1 行） |
|---|---|---|---|
| 成功（`resolve` は一致が無いパスを含んでもよい） | 0 | JSON 1 つ | なし |
| 引数の誤り（`edges` は `--json` が無い・位置引数・未知のオプション・値の無いオプション・空文字列の値。`resolve` はこれらに加えて、パスが無い・正規化できないパスを含む。`resolve` は DB を開かない） | 2 | なし | `[aegis] edges: <理由>`・`[aegis] resolve: <理由>`（例: `--json is required`、`Unknown option '--bogus'. ...`、`--db requires a non-empty value`、`at least one <path> is required`、`path is outside the project root: ../x.ts`） |
| DB ファイルが無い | 2 | なし | `[aegis] Database not found at <絶対パス>` |
| DB ファイルが 0 バイト（1 度読み直しても）・SQLite として読めない・その他の例外 | 2 | なし | `[aegis] edges: <例外のメッセージ（改行は空白に置き換える）>`・`[aegis] resolve: <同左>` |

- 環境変数 `AEGIS_SNAPSHOT_RETENTION` が不正な値のときは、既存の規則どおり警告が stderr に 1 度出る。
- DB ファイルを読む前後でロック（`<db>.lock`）を作らず、待たない。DB ファイルとその隣（`<db>.lock`・`<db>.tmp-*`・`.aegis/.gitignore`）を作成・変更・削除せず、DB ファイルが無いときディレクトリも作らない。`resolve` は compile_log も書かない。書き手は一時ファイルと rename で DB を置き換えるので、ロックを取らずに読んでも、置き換えの前か後の完全な内容を読む。

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
  - 承認済みのエッジと経路のキー（`source_type`・`source_value`・`target_doc_id`・`edge_type`）が同じ `add_edge` は、`reason: "duplicate_edge"` で却下する（`detail` に衝突先の `edge_id`）。同じ実行内で先に承認した `add_edge` とも衝突を見る（`--dry-run` では先に `would_approve` へ入れたものと見る）。衝突先を pending の `remove_edge`・`retarget_edge`・`deprecate`（エッジ）が変える予定のときは却下せず、承認を試みる。
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
| `src/cli/read-commands.ts`・`src/core/read/knowledge-query.ts` | `edges`・`resolve` の引数・出力・終了コード |
| `src/cli/admin-commands.ts`・`src/mcp/tool-input-schemas.ts` | admin の操作の CLI の引数・入力の検証・出力・終了コード |
| `src/core/init/install-marker.ts` | 導入済みの目印の判定・起動モード・待機モードの文言 |
| `src/mcp/server.ts`・`src/mcp/services.ts`・`src/mcp/tool-error.ts` | ツールの登録・引数・サーフェスの検査・Observation の検証・エラー応答 |
| `src/core/read/compiler.ts`・`src/core/read/allocator.ts`・`src/core/types.ts` | compile の選び方・出力の形・delivery・notices |
| `src/core/store/database.ts`・`src/core/store/snapshot-pruning.ts` | DB ファイル・ロック・一時ファイル・snapshot の保持と圧縮 |
| `src/core/optimization/staleness.ts`・`src/core/optimization/repo-file-listing.ts`・`src/core/optimization/staleness-ack.ts`・`src/core/automation/approve-pending.ts` | フォーク固有の振る舞い |
| `src/core/source-sync-staleness.ts`・`src/core/project-share/`・`src/adapters/`・`src/expansion/models.ts` | reconcile の notices・共有ファイル・アダプタの配布先・モデル |
| `package.json` | パッケージ名・版・Node.js の要件 |
| `docs/adr/019-operations-lightening.md` | フォーク固有の振る舞いの決定の範囲 |
| `docs/adr/020-ssa-surface.md` | ssa サーフェスのツールの集合とサービス層の許可 |
