# ADR-019: Operations Lightening, Dependency Refresh, and Node.js 26 Floor

**ステータス:** Accepted
**日付:** 2026-11-01

## 関連ドキュメント

- [ADR-018: Collaborative Project-Share Authoring](018-collaborative-project-share-authoring.md)
- [ADR-015: Knowledge Optimization Architecture](015-knowledge-optimization-architecture.md)

---

## コンテキスト

参考プロジェクトでの運用の実測で、`maintenance` 1 回 13.7 秒の 92% が semantic staleness の走査
（`collectSemanticStalenessFindings` 内のファイル一覧の取得と指紋の採取）に費やされていた。
走査は `.gitignore` を見ず、`.venv` などの無視設定されたファイルまで辿っていた。
あわせて、運用上次の摩擦が確認された:

- pending の提案を承認するたびに AI エージェントが MCP を呼ぶ必要があり、件数に比例して往復が増える
- snapshot の内容行（`snapshot_docs` / `snapshot_edges` / `snapshot_layer_rules`）が承認のたびに増え続け、DB ファイルが肥大する
- MCP ツールのエラー応答が、`Error` でない値が投げられると `Sync failed: undefined` になり、原因が分からない
- 依存が古く、パッケージ管理が npm のままで開発ルール（pnpm）と合っていない

本 ADR は、これらに対する 6 つの決定と、その根拠・検討した選択肢を記録する。

---

## Non-goals

- DB スキーマの変更（マイグレーションの追加、`staleness_baselines` への版の列の追加を含む）
- `knowledge_version` / `snapshot_id` の semantics の変更
- agent surface へのツール追加（agent 6 ツール・admin 24 ツールのまま）
- `@modelcontextprotocol/sdk` の v2 系（別パッケージ群）への移行
- npm レジストリへの公開方法と、利用者向けの `npx -y @fuwasegu/aegis@<版>` による起動の変更

---

## 決定

### D-1: staleness の検査対象を `git ls-files` に絞り、アルゴリズムの版を `015-10-3` にして基準値を移行する

検査対象のファイル一覧を `git ls-files --cached --others --exclude-standard -z`
（`src/core/optimization/repo-file-listing.ts`）から得る。
`SKIP_DIR_NAMES` を含むパス、通常ファイルでないもの（シンボリックリンク、サブモジュール、削除済み）は除く。
git が未導入、作業ツリーの外、またはプロジェクトのルート自体が（上位リポジトリの設定で）無視されているとき（`git check-ignore -q -- .` が終了コード 0）だけ従来の再帰走査に戻る。
ルートが無視されていると `git ls-files` は何も返さないため、git の一覧を使わない。
作業ツリーの中で `git ls-files` が失敗したときは `RepoListingError` を投げ、走査には戻らない
（戻ると無視設定されたファイルが一覧に入り、`linked_file_added` が一斉に出るため）。

`SEMANTIC_STALENESS_ALGORITHM_VERSION` を `015-10-2` から `015-10-3` に更新する。
基準値にあって今回の一覧に無いパスのうち、「今回の指紋の対象に入っていない・一覧にない・ディスクに実在する・
エッジの glob に一致する」の 4 条件がそろうものは「検査対象から外れた」とみなし、
`linked_file_removed` を出さずに基準値を書き直す。実際の削除やエッジ変更による不一致は従来どおり検出する。
また、基準値にあって今回の指紋に無いパスのうち、今の一覧の対象から外れるもの（`git check-ignore` が無視と判定する、
または `node_modules` などの除外ディレクトリの配下にある）は、ディスクに無くても `linked_file_removed` を出さない。
旧版の走査で作った基準値には `.venv/` などの無視対象のファイルが入っており、それらが消えると毎回指摘が出続ける。
指摘がある間は基準値を書き直さないため、自然には解消しなかった（mcp-chest-memory で 8,751 件、maintenance が 11 分 53 秒。
修正後は 355 件・2.4 秒）。`git check-ignore` が失敗したときは、従来どおり指摘する側に倒す。
さらに、文書の `path_requires`／`path` のエッジを承認で変えたとき（`add_edge`・`retarget_edge`・`remove_edge`、
およびエッジを変える `materialize`）は、その文書の基準値を同じトランザクションで消す。基準値の対象のパスはエッジで決まるので、
エッジが変われば基準値は必ず古くなる。消さないと、エッジの変更で生じた差分が指摘として残り、指摘がある間は基準値を書き直さないため、
永久に消えない（searxng-crawl4ai-mcp で TypeScript から Python へ移植した後にエッジを付け替えても 263 件が残った）。
コードだけが変わったドリフト（`symbol_drift` など、エッジを変えずに生じたもの）は、この変更では解消しない。
それは、人が文書とコードを照らして確かめた後に、admin 専用の CLI `staleness-ack` で確定する。`staleness-ack` は、指定した文書の基準値を今のファイルから取り直し、
その文書の Level 3 の `staleness_detected` 観測をアーカイブする。アーカイブしないと、`maintenance` の重複判定
（アーカイブされていない観測と同じ内容の指摘は記録しない）により、同じドリフトが再び起きても記録されない。

**代替案:**
- `.gitignore` を自前で解析する（`ignore` パッケージ等）: ネストした `.gitignore` や `info/exclude` を再実装することになり、git の結果とずれる。
- `staleness_baselines` に `algorithm_version` 列を足して版の不一致で基準値を破棄する: 正確だが、スキーマ変更とマイグレーションを伴い、本機能の範囲に対して過大。

### D-2: 指紋の採取を 1 回の呼び出し内でメモ化する

`collectSemanticStalenessFindings` の 1 回の呼び出しごとに `FingerprintMemo`（`Map<string, string | null>`。null も記憶する）を作り、
同じファイルを指す複数の文書で指紋を 1 回だけ採取する。メモは呼び出しをまたいで保持しない。

**代替案:**
- モジュールスコープの LRU キャッシュや mtime をキーにしたキャッシュ: 古い指紋を返す危険、または mtime の粒度と巻き戻しによる誤りがある。

### D-3: `approve-pending` を CLI 専用にして MCP に公開しない（INV-6）

pending の提案を種類の順序（`bootstrap → new_doc → update_doc → add_edge → retarget_edge → remove_edge → deprecate → materialize`、
同種の中は `created_at` 昇順）で一括承認する CLI サブコマンドを追加する。
コアは `src/core/automation/approve-pending.ts` で、提案ごとに `repo.approveProposal` を呼ぶ
（個別承認と同一の経路。1 件ごとにトランザクション 1 回・snapshot 1 世代）。
途中で失敗しても成功分は承認済みのまま残る。`bundle_id` を持つ提案は承認せず `skipped`（`reason: 'bundled'`）にする
（バンドルの all-or-nothing は `aegis_approve_proposal_bundle` が担う）。
承認の直前に pending でなかった提案と、承認トランザクションで失敗した後に再取得して pending でなかった提案（別プロセスが先に承認した場合）は、失敗ではなく `skipped`（`reason: 'no_longer_pending'`）にする。
同じ `doc_id` の pending の `update_doc`（バンドル外）は、`created_at` が最後のものだけを承認の候補にし、古いものは `superseded` で却下する。最後のものも、内容の SHA-256 が `primaryAssetPathForHashSync` で解決した現在のソースファイルと異なれば `stale_content` で却下する（ソースファイルが無い・解決できないときは比べずに承認する）。`document_import` の観測からの `update_doc` は観測時点の内容を持つため、古い観測から作られた提案を順に承認すると、文書が現在のファイルより古い内容に戻る（2026-11-01、service-news の news-plan で実際に起きた）。却下は `repo.rejectProposal(id, reason, { reanalyzeEvidence: false })` で行い、根拠の観測を再分析の対象に戻さない（戻すと次の `maintenance` が同じ古い提案を作り直す）。却下した提案は結果の `rejected`（`--dry-run` では `would_reject`）に載せる。
失敗を含むときの終了コード 1 は `process.exitCode` で設定する（`process.exit()` は標準出力のパイプを切り、JSON が途中で欠けることがあるため）。
MCP ツールは追加せず、`AegisService.approvePending` は `assertAdmin` を通す。
AI エージェントが承認のために MCP を呼ぶ回数を 0 にしつつ、Canonical の変更に人間の承認を要する INV-6 / P-3 を構造的に保つ。

**代替案:**
- MCP ツール `aegis_approve_pending`（admin 限定）を追加する、または `aegis_approve_proposal` に配列を受け付けさせる: エージェントが MCP を呼ぶ回数が 0 にならず、ツール数・アダプタのテンプレートにも波及する。
- 全体を 1 トランザクションにして all-or-nothing にする: 部分成功を残す要件に反する。

### D-4: snapshot の保持外の世代の内容行を刈り込み、空き領域が 1 MiB かつ 25% 以上のときだけ `VACUUM` する

`createSnapshot()` の末尾で `pruneSnapshots` を呼ぶ。保持する世代は、`knowledge_version` 降順の先頭 `retention` 件
（既定 20。`AEGIS_SNAPSHOT_RETENTION` またはコンストラクタ引数で変更）と、
`compile_log.snapshot_id`・`observations.related_snapshot_id`・`init_manifest.initial_snapshot_id` が参照する世代の和集合。
保持外の世代は `snapshot_docs` / `snapshot_edges` / `snapshot_layer_rules` の行だけを削除し、`snapshots` のヘッダ行は残す
（外部キーの参照と `knowledge_version` / `snapshot_id` の対応を保つため）。刈り込みの失敗は承認を失敗させない。

これは **INV-3（Snapshot 不変性）の緩和**である。「保持外の世代の内容行は刈り込まれうる。残した行は変更しない」に文書の記述を改める。
内容行は `src` のどこからも読まれておらず、compile の監査（`aegis_get_compile_audit`）は `compile_log` の記録に依存するため、再現性と監査は保持側の世代で守られる。

`DELETE` だけでは sql.js の `export()` のサイズは縮まない（実測: `VACUUM` で 4.38 MB から 0.45 MB）。
そこで maintenance の最後（非 dry-run、トランザクションの外）に、空きページが `COMPACTION_MIN_FREE_BYTES`（1 MiB）以上かつ
`COMPACTION_MIN_FREE_RATIO`（0.25）以上のときだけ `VACUUM` を実行する。dry-run は判定だけを報告する。
閾値の値は経験的な推測であり、変更が必要なら定数だけを変える。

**代替案:**
- ヘッダも削除して外部キーを外す: マイグレーションが必要で、INV-3 の破壊が大きい。
- 刈り込みのたびに `VACUUM`、または `PRAGMA auto_vacuum`: 前者は承認ごとに DB 全体を書き換えて遅く、後者は sql.js の `export()` との相性が未確認で既存 DB にも `VACUUM` が要る。

### D-5: MCP ツールのエラー応答に原因を含める

`src/mcp/tool-error.ts` の `errorMessage(e: unknown)` と `toolErrorResult(prefix, e)` を置き、
`server.ts` の 6 つの `catch (e: any)` を `catch (e: unknown)` と `toolErrorResult` の呼び出しに置き換える。
`Error` でない値（`undefined`、文字列、`message` の無いオブジェクト）が投げられても原因が応答に入り、`Sync failed: undefined` にならない。
スタックは応答に含めず標準エラーに出す（MCP の応答はエージェントの文脈に載り、トークンと内部情報の露出になるため）。

**代替案:**
- 共通ミドルウェアで全ツールのハンドラを包む: `compile_context` / `observe` は意図的に再スローするため、一律に包むと挙動が変わる。

### D-6: 依存を最新にし、Node.js の下限を 26 にし、パッケージ管理を pnpm に移す

- **依存:** 2026-10-31 時点の最新の安定版に更新する。例外として **`@modelcontextprotocol/sdk` は 1.x（1.32.2）に留める**。
  MCP SDK の v2 系は別パッケージ群（`@modelcontextprotocol/server`・`client`・`core`）に分割され、
  `registerTool` などの API が異なる。移行は別パッケージへの置き換えとサーバー登録コード全体の書き直しになり、本機能の範囲を超える。後継の移行は別の機能とする。
- **Node.js:** `engines.node` を `>=26.0.0` にし、CI のマトリクスとリリースを Node 26 に揃える。
  `vitest` 5 の前提（Node 22.12 / 24 / 26 以上）とも整合する。
- **pnpm:** `package-lock.json` を `pnpm-lock.yaml` に置き換え、`package.json` に `packageManager: pnpm@12.8.1` を足す。
  pnpm は build script の承認が無いと `ERR_PNPM_IGNORED_BUILDS` で失敗するため、
  新規 `pnpm-workspace.yaml` の `allowBuilds` で `esbuild: false`、`node-llama-cpp: true` とする
  （pnpm 12 は `package.json` の `pnpm.allowBuilds` を読まない。単一パッケージでも `pnpm-workspace.yaml` が要る）。
  `node-llama-cpp` は npm のときと同じく postinstall を実行する現状維持の扱い。
- **変えないもの:** npm レジストリへの公開、利用者向けの `npx -y @fuwasegu/aegis@<版>` による起動、
  利用者向けメッセージ（`npm install node-llama-cpp`）。
- 未検証: `pnpm publish --provenance` が GitHub Actions の OIDC で実際に provenance を付けられるかは、初回のリリースで確かめる。
  問題があれば公開の 2 ステップだけ `npm version` / `npm publish` に戻す（公開物の内容は同じ）。

**代替案:**
- `@modelcontextprotocol/sdk` を v2 に上げる: 本決定の「依存」の項のとおり範囲外。
- npm のままにする、または `package.json` の `pnpm` フィールドで承認する: 前者は開発ルールに反し、後者は pnpm 12 が読まない。

---

## 却下した代替案

各決定の「代替案」に記したもののほか、全体を通した却下は次のとおり。

### A-1: 運用の軽量化を MCP ツールの追加で実現する

却下。D-3 のとおり、承認の一括化を MCP に出すとエージェントの呼び出しが減らず、INV-6 の構造的な保証も弱まる。

### A-2: DB スキーマを変更して staleness の版管理と snapshot の保持を行う

却下。D-1・D-4 のとおり、スキーマ変更・マイグレーション・ダウングレード不可を伴い、DB 形式を変えない本機能の範囲に対して過大。

---

## 帰結

### 正の帰結

- maintenance の主要コスト（無視設定されたファイルの走査）が除かれ、同一ファイルの指紋の重複採取もなくなる
- 一括承認により、承認のための MCP の往復が 0 になる
- snapshot の内容行と DB ファイルの肥大が抑えられる
- エラー応答から原因が分かる

### 負の帰結

- INV-3 が緩和され、保持外の世代の内容行は復元できない（ヘッダ、`compile_log` の記録、保持側の世代は残る）
- アルゴリズムの版の更新により、未アーカイブの旧版の `staleness_detected` 観測と重複した観測が初回に 1 回だけ作られうる
- Node.js 26 未満は動作要件から外れる。開発手順は pnpm 前提になる
- `@modelcontextprotocol/sdk` は 1.x のまま残り、v2 への移行は別途必要
