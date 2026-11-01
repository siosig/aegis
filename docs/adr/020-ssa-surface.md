# ADR-020: SSA Surface（speck-serena-aegis 向けの第 3 のサーフェス）

**ステータス:** Accepted
**日付:** 2026-11-01

## 追記（2026-11-01、改修 5）

ssa から `aegis_approve_proposal` を外した。ssa のツールは 13 本から 12 本に、サービス層の許可リストは 8 操作から 7 操作になった。

理由は、`aegis_observe`（`document_import`・`manual_note`・`compile_miss`）→ `aegis_process_observations` → `aegis_approve_proposal` の経路で、文書の取り込みを通らずに文書・エッジを Canonical に足せたことである。P-3 の Proposed → Canonical の昇格を MCP に出さないことにした。

承認は、人が CLI の `approve-proposal`（1 件。`modifications` を付けられる）・`approve-proposal-bundle`・`approve-pending` か、admin surface で行う。

この追記より下の本文は、改修 5 の後の内容に直してある。旧 D-4 の内容は、D-4 の経緯の 1 文に残した。

## 関連ドキュメント

- [ADR-019: Operations Lightening, Dependency Refresh, and Node.js 26 Floor](019-operations-lightening.md)
- [ADR-014: Maintenance CLI とフィードバック自動化](014-maintenance-cli-and-feedback-automation.md)
- [ADR-003: Observation 自動化パイプラインは admin 明示処理とする](003-observation-automation-pipeline.md)

---

## コンテキスト

speck-serena-aegis（以下 ssa）は、AI エージェントが aegis の docs を運用する構成である。運用では、pending の提案の確認、観測の処理、文書との同期、古い観測の退避、統計の確認を MCP 経由で行う。承認は人が CLI か admin surface で行う（改修 5）。

既存の 2 つのサーフェスは、この運用に合わない。

- admin（24 本）は、文書の取り込み（`aegis_import_doc`・`aegis_analyze_doc`・`aegis_analyze_import_batch`・`aegis_execute_import_plan`）、テンプレートの更新（`aegis_check_upgrade`・`aegis_apply_upgrade`）、提案の却下まで AI に出す。ssa の運用には広すぎる。
- agent（6 本）は、提案の承認、観測の処理（`aegis_process_observations`）、文書との同期（`aegis_sync_docs`）ができない。ssa の運用には狭すぎる。

本 ADR は、この 2 つの間に第 3 のサーフェス `ssa` を足す決定と、その根拠・検討した選択肢を記録する。

---

## Non-goals

- ssa 側（speck-serena-aegis）の MCP の設定
- CLI のサブコマンド（`maintenance`・`approve-pending`・`staleness-ack`・`share-*`）の変更。CLI はサーフェスを持たない（改修 5 で admin だけの操作の CLI（`import-doc` ほか 9 つ）を足した。CLI はサーフェスを持たない点は変わらない）
- 承認の記録に surface の区別を付けること（承認者の欄に ssa か admin かを残さない）

---

## 決定

### D-1: ssa は 12 本のツールを登録する

ssa に登録するのは、agent の 6 本（`aegis_compile_context`・`aegis_observe`・`aegis_get_compile_audit`・`aegis_get_known_tags`・`aegis_workspace_status`・`aegis_init_detect`）と、次の 6 本である。

- `aegis_list_proposals`
- `aegis_get_proposal`
- `aegis_archive_observations`
- `aegis_get_stats`
- `aegis_process_observations`
- `aegis_sync_docs`

admin の 24 本のうち、ssa に出さない 12 本は次のとおりである。

- `aegis_import_doc`
- `aegis_analyze_doc`
- `aegis_analyze_import_batch`
- `aegis_execute_import_plan`
- `aegis_apply_upgrade`
- `aegis_check_upgrade`
- `aegis_init_confirm`
- `aegis_reject_proposal`
- `aegis_preflight_proposal_bundle`
- `aegis_approve_proposal_bundle`
- `aegis_approve_proposal`
- `aegis_list_observations`

登録は `src/mcp/server.ts` の 2 区画で分ける。`surface === 'ssa' || surface === 'admin'` の区画に上の 6 本を、`surface === 'admin'` の区画に出さない 12 本を置く。agent の 6 本は従来どおり全サーフェスの共通区画にある。

### D-2: サービス層は許可リストで ssa を閉じる

`AegisService` の検査 `assertAdmin` を `assertSurfaceAllows(operation, surface)` に置き換える（`src/mcp/services.ts`）。判定は純関数 `isOperationAllowedOnSurface` に切り出し、規則は次の表のとおりとする。

| surface | 判定 |
|---|---|
| `admin` | すべて許す |
| `ssa` | `SSA_ALLOWED_OPERATIONS` に含まれるものだけ許す |
| `agent` | すべて拒否する |

操作名は 22 個の文字列リテラルの union 型 `SurfaceGatedOperation` とし、`SSA_ALLOWED_OPERATIONS` は次の 7 操作に限る。許可リストの綴りの誤りは `tsc --noEmit` で落ちる。

- `aegis_list_proposals`
- `aegis_get_proposal`
- `aegis_archive_observations`
- `aegis_get_stats`
- `aegis_sync_docs`
- `aegis_process_observations`
- `analyzeAndPropose`

7 番目の `analyzeAndPropose` は MCP ツールではなく、サービス層が内部で呼ぶ操作である。許可リストに入れる理由は、ssa の 6 本のツールが内部で呼ぶ連鎖にある。各メソッドの検査はメソッド本体の最初の文なので、拒否されたときに副作用は起きない。

| 呼び出し元 | 内部で呼ぶ操作 | ssa での扱い |
|---|---|---|
| `syncDocs` | `processObservations('staleness_detected', surface)` | 許す |
| `processObservations` | `analyzeAndPropose(analyzer, et, surface)` | 許す（`analyzeAndPropose` を許可リストに入れる理由） |
| `runMaintenance` | `processObservations`・`syncDocs`・`checkUpgrade` | `runMaintenance` 自身が先頭で拒否されるので、内部の呼び出しに届かない |
| `importDoc` | `analyzeAndPropose(analyzer, 'document_import', surface)` | `importDoc` 自身が先頭で拒否される |

- `aegis_sync_docs`（ssa が許す）は `processObservations` を呼び、`processObservations` は `analyzeAndPropose` を呼ぶ。`analyzeAndPropose` を許可リストに入れないと、ssa の `aegis_process_observations` と `aegis_sync_docs` が途中で拒否される。
- `checkUpgrade` は、ssa の 6 本からは呼ばれない（`runMaintenance` 経由だけ）ので、許可リストに入れない。入れると、テンプレートの更新の確認が ssa に開く。
- `processObservations` に `event_type: 'document_import'` を渡すと、admin の `aegis_import_doc` が記録した未分析の観測から `new_doc`・`add_edge` の提案が作られる。これは admin と同じ振る舞いで、制限しない。作られた提案は承認を経るので、P-3 は保たれる。
- `aegis_observe` は agent のツールで、サーフェスを検査しない。ssa も `document_import`・`manual_note`・`compile_miss` の観測を記録でき、`aegis_process_observations` で `new_doc`・`update_doc`・`add_edge` の提案を作れる。提案は作れるが、承認はできない（承認は人が CLI か admin surface で行う。改修 5）。ssa が作った提案が Canonical になるのは、人が承認したときだけである。観測と提案の作成は制限しない（`document_import` だけを拒否しても `manual_note` から `new_doc` の提案は作れ、閉じない）。ssa に出さない「文書の取り込み」は、文書の内容・ファイルから観測と提案を 1 回の操作で作る直接の取り込みツール（`aegis_import_doc`・`aegis_analyze_doc`・`aegis_analyze_import_batch`・`aegis_execute_import_plan`）を指す。agent の `aegis_observe` の振る舞いは変えない。

拒否時の例外 `SurfaceViolationError` とその文面は変えない。agent の拒否は従来どおり全拒否である。

### D-3: ssa は起動時の source_path の正規化を実行しない

`src/main.ts` の `runInitialBaselineSourcePathMigration`（migration 001 のデータ移行。ADR-013 の baseline）は、`surface === 'admin'` で起動したときだけ実行する。この条件を変えず、ssa では実行しない。

### D-4: 承認を ssa に出さない

ssa は、1 件の承認・バンドルの承認・一括承認のいずれも持たない。承認は CLI（`approve-proposal`・`approve-proposal-bundle`・`approve-pending`）か admin surface で行う。

経緯として、改修 1 では ssa の `aegis_approve_proposal` を提案の種類で制限せずに出していたが、改修 5 で外した。

「エッジを変える経路を出さない」が指すのは、提案を経ずにエッジを直接変える経路である。該当するのは CLI の `share-materialize`・`share-hydrate` だけで、これらは MCP に無い。ssa の 12 本に、エッジを変えるツールは無い（提案は作れるが承認できない）。

---

## 却下した代替案

### A-1: admin をそのまま ssa の運用に使う

却下。文書の取り込み・テンプレートの更新・提案の却下まで AI に出る。ssa の運用に不要な操作まで AI に渡ることになる。

### A-2: ツールの登録だけで絞る

却下。登録の誤り 1 つで ssa から admin のツールが呼べてしまう。サービス層の許可リストを足し、登録とサービス層の二重で閉じる（INV-6 の agent と同じ二重の防御にそろえる）。

### A-3: aegis_reject_proposal も ssa に出す

却下。利用者の決定として、提案の却下は ssa に出さない。却下は人が admin で行う。

---

## 不変条件との関係

### INV-6

agent の登録と検査は変えない。agent は引き続き全操作が拒否され、Canonical を変えられない。ssa で Canonical を変える操作は無い。許すのは承認を要する提案を作る操作（`aegis_process_observations`・`aegis_sync_docs` の内部）だけである。許可リストとツールの登録の二重で、ssa に出す範囲を閉じる（D-1・D-2）。

### P-3

ssa は承認を持たない。人の承認は CLI か admin surface で行う。一括承認 `approve-pending` は CLI 専用のままにする。`approve-pending` は、サービス層でも `aegis_approve_pending` として ssa から拒否される（許可リストにない）。バンドルの承認（`aegis_preflight_proposal_bundle`・`aegis_approve_proposal_bundle`）も出さない。文書の取り込み・テンプレートの更新・提案の却下・初期化は ssa に出さず、人が admin で行う。

### ADR-019 D-3・A-1 との整合

ADR-019 の D-3 と A-1 は、承認を MCP の新ツールで一括化することを、INV-6 の構造的な保証が弱まるとして却下した。ssa は次の点で整合する。

- 新しい承認ツールを足さない。ssa は承認を持たない（1 件の承認は CLI の `approve-proposal`）。
- 一括承認を出さない。`approve-pending` は CLI 専用のままで、ssa からはサービス層で拒否される。
- ADR-019 が問題にした「承認の一括化による呼び出し回数の削減」を、ssa で実現しようとしていない。
