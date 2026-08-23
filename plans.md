# plans.md

## 1. スコープ
- MVPでやること
  - [ ] CSV を読み込み、Tree と DataGrid に同期表示する
  - [ ] DataGrid で編集でき、検証結果が UI に反映される
  - [ ] `schema/` 配下の OWL を参照し、オントロジーに従った RDF を出力できる
  - [ ] YAML 形式での出力（RDF を YAML 表現に変換/保存）ができる
  - [ ] unit（vitest）と e2e（playwright）の最小セットが通る
- Non-goals（MVPでやらないこと）
  - [ ] ドラッグ&ドロップでの親子関係変更
  - [ ] 高度なスキーマ管理（JSON Schema/LinkML）
  - [ ] ネイティブアプリ化（Tauri）
  - [ ] IFC/DTDL など外部フォーマットへのエクスポート

## 2. 成果物（Deliverables）
- [ ] UI（2ペイン: Tree + DataGrid）
- [ ] CSV 入力（読み込み）
- [ ] Tree 連動（選択/展開とグリッド同期）
- [ ] 編集（行/セル更新）
- [ ] 検証（zod + 参照整合）
- [ ] RDF 出力（OWL オントロジー準拠）
- [ ] YAML 出力（RDF 由来の構造化出力）
- [ ] unit/E2E テスト（最小シナリオ）

## 2.1 UI モード設計方針（CSV 表示 / データモデル編集）
### 目的
- CSV の原本表示と、選択リソースのデータモデル編集を明確に分離する。
- データモデル編集モードではプロパティの説明を参照でき、追加・編集したプロパティが出力に反映されることを担保する。

### モード定義
- CSV 表示モード
  - 目的: 入力 CSV の列/行を原本として確認する。
  - 表示: 全行・全列を CSV そのままに表示（未知列も保持）。
  - 編集: ここでは基本的に読み取り専用（誤編集防止）。必要なら「編集はデータモデル編集モードで行う」旨を表示。
  - 連動: Tree の選択状態に応じてフィルタ表示できる（任意）。
- データモデル編集モード
  - 目的: Tree で選択されたリソースのデータモデルを編集する。
  - 表示: 選択リソースのプロパティ一覧（既存 + 追加分）を DataGrid で表示。
  - プロパティ説明: `schema/` の OWL / JSON Schema からラベル・説明・必須/任意を取得し、UI で参照可能にする（ツールチップ/詳細パネル）。
  - 編集結果: 追加・編集したプロパティは state に保持し、RDF/YAML 出力に必ず反映する。

### 状態管理とデータフロー方針
- 「CSV 原本」と「データモデル編集結果」を分離管理する。
  - CSV 原本: 読み込み直後の行/列を保持（未知列含む）。
  - 編集結果: Tree 選択単位のプロパティ編集結果を保持（追加プロパティ含む）。
- モード切替時のルール
  - CSV 表示モードへ戻っても編集結果は保持し、出力は編集結果を優先する。
  - モード切替で Tree の選択/展開状態を失わない。

### UI / 操作方針
- モード切替 UI（タブ or トグル）を設置し、現在のモードを視認できるようにする。
- データモデル編集モードでは、未定義プロパティの追加 UI を提供する（追加時は説明の登録もサポート）。
- 出力対象は「データモデル編集結果 + CSV 原本の未知列」を統合する。

## 2.2 テスト方針（CSV 表示 / データモデル編集）
### ユニットテスト（packages/core）
- CSV 原本の保持: 未知列を含む CSV が変更なく保持される。
- データモデル編集結果の保持: 追加・編集したプロパティが state/モデルに反映される。
- 出力統合: 編集結果が RDF/YAML 出力に反映され、CSV 原本の未知列が損なわれない。
- プロパティ説明参照: schema 由来の説明/ラベルが取得できる（最低 1 ケース）。

### E2E（apps/web）
- モード切替:
  - CSV 表示モードで原本が表示される。
  - データモデル編集モードに切替え、選択リソースのプロパティが表示される。
- プロパティ説明参照:
  - データモデル編集モードで説明が参照できる（tooltip or detail panel）。
- 編集 → 出力:
  - プロパティを追加/編集し、RDF/YAML 出力に反映される。
- 回帰:
  - モード切替後も Tree の選択状態が維持される。
  - CSV 表示モードに戻っても編集結果が失われない。

## 2.3 空間構成の再編成（階層シグナル列）
### 設計方針
- 対象列の編集（`site`/`siteName`/`siteId`, `building`/`buildingName`/`buildingId`, `level`/`levelName`/`floor`/`floorName`, `installationArea`/`room`/`space`/`targetArea`/`zone`, `deviceId`/`deviceName`, `pointId`/`pointName`）がコミットされた時点で空間構成を再構築する。
- 再構築は「編集差分 → 影響行抽出 → Tree 再構築 → 選択/展開状態の復元」の順で行う。
- 既存のルール（`parent_id`/`kind`）と矛盾する場合は、編集後の列値を優先し、参照整合エラーとして検出する。
- CSV 未知列は維持し、再構築は階層キーにのみ影響する。
- 空間構成再編成の責務は `packages/core` に集約し、UI は再構築結果の反映に専念する。

### 期待動作
- 階層シグナル列のいずれかを編集しコミットすると、該当行が新しい階層に移動する。
- 階層の親が存在しない場合は自動生成せず、バリデーションエラーとして一覧化する。
- Tree 再構築後も、編集対象の行が選択/フォーカスされるよう復元する。

### テスト方針
#### ユニットテスト（packages/core）
- 編集差分の検出: 対象列変更時のみ再構築対象になる。
- 再構築: 変更後の階層キーに基づき Tree が再編成される。
- 参照整合: 親階層が存在しない場合にエラーが返る。
- 未知列保持: 再構築後も未知列の順序/値が保持される。

#### E2E（apps/web）
- DataGrid で対象列を編集 → コミット後に Tree が再構築され、該当ノードが新しい階層に移動する。
- Tree 再構築後も選択状態が維持される。
- 不正な階層値でコミットした場合、バリデーションエラーが表示される。

## 2.4 デバイステンプレート管理（Device/Equipment）
### 目的
- CSV から抽出したデバイス種別（Device/Equipment）一覧を表示し、テンプレート（YAML）の管理・編集・出力を行う。
- テンプレートが存在しない場合は CSV のデバイス/ポイント対応を用いて生成し、存在する場合は差分（齟齬）を検出する。

### 設計方針
- UI に「デバイステンプレート管理」ビューを追加する。
  - デバイス種別一覧（CSV から抽出）を最初に表示する。
  - 選択したデバイス種別に対してテンプレートを読み込み/生成し、編集できる。
  - 既存テンプレートとの差分がある場合は齟齬として表示する。
- テンプレートは YAML で管理し、`templates/<namespace>/<deviceType>.yaml` のように名前空間単位で整理する（domain は namespace と等価として扱う）。
- テンプレートの基本構造:
  - `className`: デバイスのクラス名称
  - `description`: 説明
  - `properties`: プロパティ定義（`name`, `description`, `access` = `read`|`readWrite`, `default`, `pointType`）
- テンプレートが存在しない場合の生成ルール:
  - CSV のデバイスとポイントリストの紐付けから、`namespace` ごとにテンプレートを生成する。
  - 生成時の `properties` に `pointType` を必須で設定する。
- テンプレートが存在する場合の検証ルール:
  - CSV 推定の `properties` とテンプレートの `properties` を比較し、不足/過剰/型・アクセス差分を齟齬として記録する。
  - 齟齬がある場合、UI で該当プロパティをハイライトし修正可能にする。
  - 修正をコミットしたら CSV の当該 `pointType` が更新される。
- テンプレート出力:
  - 選択したテンプレート群を ZIP でまとめて出力できるようにする。

### 状態管理とデータフロー方針
- `packages/core` にテンプレート生成/検証/ZIP 出力のロジックを集約する。
  - CSV → デバイス種別抽出 → namespace 別テンプレート生成。
  - 既存 YAML の読み込み（UI 側で受け取った YAML をパース）と差分判定。
  - ZIP 生成はテンプレート YAML を名前空間パスに並べる。
- UI は core で生成したモデルを表示し、編集結果をテンプレートへ反映する。

### テスト方針
#### ユニットテスト（packages/core）
- デバイス種別抽出: CSV から Device/Equipment の種別一覧が得られる。
- テンプレート生成: CSV のデバイス/ポイント関係から namespace 別の YAML 定義が生成される（`pointType` を含む）。
- テンプレート差分: 既存テンプレートと CSV 推定値の齟齬が検出される。
- ZIP 出力: 生成テンプレートが `templates/<namespace>/` で ZIP 化される。

#### E2E（apps/web）
- デバイス種別一覧が表示される。
- テンプレートが存在しない場合に生成され、編集できる。
- テンプレートが存在する場合に差分が表示される。
- テンプレート ZIP 出力が完了する。

## 2.5 デバイステンプレートの継承（Base/派生）
### 目的
- テンプレートに基底クラス（Base）を導入し、description/version など共通プロパティを継承できるようにする。
- Base を事前生成してテンプレート管理ビューで選択できるようにする。

### 設計方針
- テンプレート構造に `extends`（親クラス参照）を追加する。
  - 例: `className`, `description`, `extends`, `properties`
- Base テンプレートは `templates/<namespace>/Base.yaml` として事前生成・保持する。
- UI はテンプレート編集画面に「継承元（Base/他クラス）」のコンボボックスを用意する。
- `packages/core` は継承の解決・マージ結果を提供し、UI は選択状態を保存する。
- 継承の解決は循環参照を検出してエラー化する。

### テスト方針
#### ユニットテスト（packages/core）
- Base 生成: namespace ごとに Base が生成される。
- 継承解決: Base を指定したテンプレートに共通プロパティが展開される。
- 循環検出: 継承ループが検出される。

#### E2E（apps/web）
- Base の選択 UI が表示され、選択変更でテンプレートの表示が更新される。
- Base を含むテンプレートの出力が正しく生成される。

## 2.6 出力（フォーマット/シリアライズ）プラグイン化
### 目的
- ヘッダーの「書き出す」を拡張可能にし、フォーマット/シリアライズ方式を選択して出力できるようにする。

### 設計方針
- `packages/core` に出力プラグインのレジストリを用意する。
  - プラグインは `id`, `label`, `format`, `serializer`, `run()` を持つ。
  - 例: RDF-Turtle, RDF-JSONLD, YAML など。
- UI は 2 つのコンボボックス（フォーマット/シリアライズ）と実行ボタンを配置する。
- 既存の RDF/YAML 出力はプラグイン経由に移行する。

### テスト方針
#### ユニットテスト（packages/core）
- レジストリ登録: プラグイン一覧が取得できる。
- 出力実行: 選択されたプラグインが実行され、内容/拡張子が正しい。

#### E2E（apps/web）
- フォーマット/シリアライズ選択 → 出力が完了する。
- 既存の RDF/YAML 出力が同様に利用できる。

## 2.7 階層ツリー編集対象の拡張（空間/機器）
### 目的
- これまでポイントのみだった編集対象を、空間・機器のリソースにも拡張する。
- リストから抽出・分析した空間/機器のデータモデルを表示・編集できるようにする。

### 設計方針
- Tree ノード種別に「空間（site/building/floor/area）」と「機器（device/equipment）」を追加・区別する。
- DataGrid は選択ノード種別に応じて編集対象のプロパティ一覧を切り替える。
- `packages/core` で空間/機器の抽出・モデル化ロジックを提供する。

### テスト方針
#### ユニットテスト（packages/core）
- 空間/機器抽出: CSV から空間/機器リソースが抽出できる。
- モデル化: 空間/機器のプロパティが編集モデルに反映される。

#### E2E（apps/web）
- 空間ノード選択で該当プロパティが表示/編集できる。
- 機器ノード選択で該当プロパティが表示/編集できる。

## 2.8 出力時の編集反映と SHACL 検証
### 目的
- データモデル編集で追加/編集したプロパティとデフォルト値を RDF/YAML 出力に反映する。
- 空欄プロパティは出力からオミットする。
- 出力時に SHACL 検証を実行し、検証結果を UI へ返せる設計にする。

### 現状確認
- `packages/core/src` に SHACL 検証実装は存在しない。
- RDF/YAML 出力は `buildResourceGraph(rows)` の row 値のみ参照している。

### 設計方針
- `packages/core` に「編集モデル + デフォルト値」を統合して出力用の Resource モデルを作る層を追加する。
  - 追加/編集プロパティは出力に反映する。
  - デフォルト値は「空欄の場合のみ」補完する。
  - 空欄（空文字/undefined/null）のプロパティは出力に含めない。
- SHACL 検証を `packages/core` に実装し、RDF 生成前/後どちらで検証するかを決める。
  - まずは「RDF 生成後に SHACL 検証」を採用し、違反内容を Issue 形式で返す。
  - 検証結果は UI で確認できるようにする（エラー一覧に統合）。
- SHACL の shape は `schema/building_model.shacl.ttl` を正とし、出力時に参照できるようにする。

### テスト方針
#### ユニットテスト（packages/core）
- 出力統合: 編集で追加したプロパティが RDF/YAML に反映される。
- デフォルト補完: デフォルト値が空欄の場合のみ補完される。
- 空欄オミット: 空欄プロパティは出力に含まれない。
- SHACL 検証: 既知の違反ケースで violation が返る。

#### E2E（apps/web）
- 編集 → 出力: 追加項目/デフォルト値が出力に反映される。
- SHACL エラー表示: 出力時に SHACL 違反が UI に表示される。

## 2.9 入力検証データセット整備
### 目的
- CSV 入力検証で確認すべき正常系・異常系・将来の意味検証候補を、再利用できる fixture として整理する。
- `packages/core` の CSV パース / Tree 構築 / バリデーション回帰に使える小さなデータセットを追加する。

### 対象パス
- `packages/fixtures/`
- `packages/core/test/`

### 受入基準
- 必須項目欠損、階層親欠損、`parent_id` 参照不整合、未知列保持、意味検証候補をそれぞれ確認できる CSV が存在する。
- 追加 fixture の代表ケースが unit test で読み込み・検証される。

## 2.10 CLI: CSV → 任意フォーマット出力（Done）

### 目的
- `apps/web` の UI を使わずに、CSV ファイルを受け取って `packages/core` の出力プラグイン（CSV/JSON(Tree)/JSON-LD/RDF-Turtle/YAML/DTDL×2/WoT×2）のいずれかの形式に変換できるコマンドラインツールを提供する。
- UI 由来の編集・調整機能（Inspector 等）は対象外とし、「CSV 読み込み→検証→指定フォーマットで出力」の最小経路のみを実装する。

### 設計方針
- 新規ワークスペース `apps/cli`（`@repo/cli`）を追加し、`@repo/core` を `workspace:*` 依存として利用する。パース/検証/変換ロジックは新規実装せず、`parseCsv` / `validate` / `getOutputPlugins` / `runOutputPlugin` をそのまま呼び出す。
- 引数解析は `node:util` の `parseArgs`（Node 標準）のみを用い、commander/yargs 等の新規依存は追加しない。
- 実行は `tsx` によるオンザフライ実行とし、ビルド成果物（`bin` 配布）は用意しない。ルートに `pnpm cli -- ...` の委譲スクリプトを追加する。
- 出力ブロック判定は `apps/web/src/App.tsx` の `isBlockingIssue`（`severity === undefined || 'violation'`）と同じ基準を `runOutputPlugin` の戻り値 `issues` に適用する。既定ではブロックし、`--allow-issues` 指定時のみ警告扱いで書き込みを継続する。

### 対象パス
- `apps/cli/`（新規）
- ルート `package.json`（`cli` スクリプト追加、`test` スクリプトを `pnpm -r --if-present test` に変更）
- `README.md`（CLI 利用セクション追加）

### 受入基準
- `pnpm cli -- --input <csv> --format <format> [--serializer <name>] [--out <path>]` で CSV から指定フォーマットのファイル/標準出力が得られる。
- `--list-formats` で `getOutputPlugins()` 相当の一覧が確認できる。
- serializer が一意に定まらない format（DTDL/WoT）で `--serializer` 未指定時にエラーメッセージと選択肢が表示される。
- RDF/YAML 出力で SHACL violation がある場合、既定では書き込みがブロックされ、`--allow-issues` で書き込める。
- `apps/cli/test/cli.test.ts`（vitest）で上記の代表ケースが検証される。

## 2.11 大型ポイントリスト取り込み（入力上限 / 階層欠落の fail-closed）

### 目的
- 34,895 行・10.6 MB 規模の実ポイントリストを、ゲートウェイ単位に分割せず 1 回で変換・検証できるようにする（CLI）。
- 階層を解決できず出力に含まれない行を「無言で落とさない」。出力に含まれない行が 1 行でもあれば出力をブロックし、`SHACL violation 0 件` が全点を検査した上での 0 であることを保証する。
- ビルOS が受理しない `Equipment → Level` 直付け形状（`installation_area` 未設定）を検出できるようにする。

### 現状確認
- `packages/core/src/tree.ts` の `buildHierarchyTree()` は `site`/`building`/`level` のいずれかが未設定の行、および point があって device が無い行を `continue` で丸ごとスキップする。`buildOutputRows()` は tree に載った resource しか出力しないため、該当行は RDF/YAML/DTDL/WoT/Tree JSON から完全に消える。
- `floor` が `-`/`－`/空欄なら `normalizeHierarchyValue()` により level は未設定になる。実データでは 3,555 行（10.2%）が該当した。
- `validate()` の `hierarchy_missing` はダウンロードをブロックしない。Web (`apps/web/src/App.tsx`) も CLI (`apps/cli/src/index.ts`) も、ブロック判定に使うのは `runOutputPlugin` の戻り値 `issues`（SHACL/WoT 由来）だけである。
- `installation_area` が `-` の行は Room ノードが生成されないだけで、診断コードが一切発行されない。`-` は非空文字なので必須項目チェックも通過する。
- `parseCsv` は既に `options.limits` で上限を上書きできるが、本番の呼び出し元 2 箇所がいずれも渡していない。

### 設計方針
- 入力上限の緩和は CLI のみとする。`apps/web` は Worker を使わず tree 構築・`validate()`・SHACL がすべてメインスレッドで走るため、既定値（5 MiB / 20,000 行 / 100 列 / 32 KiB）を据え置く。`DEFAULT_CSV_INPUT_LIMITS` は変更しない。
- `apps/cli` に `--max-rows` / `--max-bytes` / `--max-columns` / `--max-cell-bytes` を追加し、`parseCsv` に `limits` として渡す。引数解析は `node:util` の `parseArgs` のままとし、新規依存は追加しない。
- 行スキップ条件は `packages/core/src/row-utils.ts` の `getHierarchyDropReasons()` に集約し、`tree.ts` と新設の coverage チェックが同じ述語を共有する（判定のズレを構造的に防ぐ）。`buildTree()` の挙動自体は変更しない。
- `packages/core/src/hierarchy-coverage.ts` を新設し、`checkHierarchyCoverage(rows)` が `row_dropped`（violation）と `buildingos_room_missing`（warning）を返す。`row_dropped` は入力行数・欠落行数・理由別内訳の実数を持つサマリ Issue を必ず含み、行単位 Issue の打ち切り件数も明示する。
- 未設定の Level/Room をプレースホルダとして自動生成することはしない（2.3 の「階層の親が存在しない場合は自動生成せず、バリデーションエラーとして一覧化する」方針を維持する）。
- `schema/building_model.shacl.ttl` は vendored shapes であり `Equipment locatedIn Level` を正当な形として許すため編集しない。ビルOS 固有の制約はアプリ層のチェックとして実装する。
- coverage の結果は `runOutputPlugin` の `issues` に合流させ、Web/CLI 双方のブロック判定を UI 側の変更なしに通す。tree を経由しない `CSV` と `JSON-LD` には適用しない。

### 対象パス
- `packages/core/src/row-utils.ts` / `tree.ts` / `hierarchy-coverage.ts`（新規）/ `output-plugins.ts` / `index.ts`
- `apps/cli/src/index.ts` / `apps/cli/README.md`
- `apps/web/src/components/IssuesDrawer.tsx` / `HelpModal.tsx`
- `README.md` / `pointlist.md`
- `packages/core/test/core.test.ts` / `apps/cli/test/cli.test.ts` / `apps/web/e2e/app.spec.ts`

### 受入基準
- `pnpm cli -- --input <csv> --format RDF --serializer Turtle --max-rows 40000 --max-bytes 20971520` で 20,000 行・5 MiB を超える CSV を変換できる。上限オプションに正の整数以外を渡した場合は exit 2 になる。
- 階層を解決できず出力に含まれない行がある場合、RDF/YAML/DTDL/WoT/Tree JSON の出力は既定でブロックされ（Web はダウンロード中止、CLI は exit 1）、`--allow-issues` でのみ書き込める。CSV/JSON-LD 出力はブロックされない。
- `row_dropped` サマリ Issue が入力行数・欠落行数・理由別内訳の実数を含み、行単位 Issue を打ち切った場合はその件数も明示する。
- `installation_area` が `-`/空欄の行に `buildingos_room_missing`（warning）が出力され、出力自体はブロックされない。
- `floor` が `-`/空欄のときの挙動が `pointlist.md` と UI ヘルプに日英併記で記載される。
- `packages/core/test/core.test.ts` と `apps/cli/test/cli.test.ts` の unit、`apps/web/e2e/app.spec.ts` の E2E で上記の代表ケースが検証される。

## 3. マイルストーン（M0〜M3）

### M0: リポジトリ健全性
- Definition of Done
  - [ ] `pnpm lint` が通る
  - [ ] `pnpm typecheck` が通る
  - [ ] `pnpm test` が通る
  - [ ] `pnpm test:e2e` が通る
  - [ ] 最低限の画面が表示できる（アプリ起動で白画面にならない）

### M1: CSV読み込み → Tree/表表示
- Definition of Done
  - [ ] CSV を読み込むと Tree と DataGrid に同じデータが表示される
  - [ ] Tree の選択が DataGrid の選択状態に反映される
  - [ ] 既知列/未知列が保持されている
  - [ ] unit で CSV パースと Tree 構築の主要ケースが通る

### M2: 編集 → 検証 → RDF/YAML 出力
- Definition of Done
  - [ ] DataGrid で編集した値が state に反映される
  - [ ] 検証エラーが UI で確認できる（少なくとも 1 箇所）
  - [ ] OWL オントロジーに従った RDF がダウンロードできる
  - [ ] RDF と整合する YAML がダウンロードできる
  - [ ] E2E で「編集→RDF 出力」フローが 1 本以上通る

### M3: 使い勝手（検索、エラーUX、パフォーマンス）
- Definition of Done
  - [ ] Tree/グリッドに検索機能がある（最小）
  - [ ] エラーが視認できる UX（ハイライト/サマリ）
  - [ ] 大規模 CSV での基本操作が 2 秒以内に応答する（体感）
  - [ ] E2E の待機が `locator/expect` ベースで安定している

### M4: OSS 公開準備（Issue #16、実装・ローカル検証 Completed）

#### 目的
- source repository と GitHub Pages の静的デモを、安全かつ再現可能な状態で公開する。
- 法務・セキュリティ・依存関係・CI・入出力・UI・利用者向け文書を公開品質へ引き上げる。
- npm package の公開は対象外とする。

#### 実施順と Issue 対応

| 優先度 | Issue | 作業 | 依存先 |
| --- | --- | --- | --- |
| P0 | #5 | Apache-2.0 と第三者著作物の棚卸し | なし |
| P0 | #15 | リポジトリ衛生、公開ポリシー、秘密情報検査 | #5 |
| P0 | #14 | Node/pnpm/依存関係の固定と監査 | #15 |
| P0 | #8 | Playwright の移植性と production preview 統一 | #14 |
| P0 | #13 | GitHub Actions の公開品質ゲート | #8, #14, #15 |
| P0 | #9 | CSV/RDF/YAML の入力・出力堅牢化 | #14 |
| P0 | #6 | RDF/JS ベースの SHACL Core 検証 | #9, #14 |
| P1 | #7 | MUI/Zustand/Tree/DataGrid 統一 | #9 |
| P1 | #10 | 非同期 output plugin registry への出力経路統合 | #6, #7 |
| P1 | #12 | README と利用者向け文書の公開品質化 | #5〜#10, #13〜#15 |
| P1 | #11 | GitHub Pages build/deploy と smoke test | #8, #12, #13 |

#### 公開時の固定値
- 著作権表記: `Copyright 2026 Smart Building Co-Creation Organization`
- CSV 入力上限: 5 MiB、20,000 行、100 列、1 セル 32 KiB
- Node.js: 22、package manager: `pnpm@9.15.9`
- Vite: 6.4 系、Vitest: 3.2 系、PostCSS: 8.5.18 以上の互換範囲

#### 既存タスクとの関係
- Task 36 は output plugin registry の core 実装を完了済みとする。公開品質として必要な非同期 API、UI の単一路線化、失敗時の download 抑止は Issue #10 で追加対応する。
- Task 38 は編集結果の統合と最小 SHACL 検証を完了済みとする。SHACL Core 準拠の RDF/JS 検証、詳細な Issue 変換、形式間の結果一致は Issue #6 で追加対応する。

#### Issue 別受入基準
- [x] #5: `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` が揃い、README にライセンスと著作権表記がある。来歴や再配布条件が不明な同梱物を公開対象に残さない。
- [x] #15: Playwright 成果物が追跡対象外で、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、Issue/PR テンプレートがある。gitleaks で全履歴を検査し、結果を記録する。
- [x] #14: Node.js 22 と `pnpm@9.15.9` が固定され、対象依存が安全な互換範囲へ更新される。実装時点の高・重大 advisory が 0 件で、Dependabot が pnpm と Actions を週次監視する。
- [x] #8: Playwright 管理 Chromium を使用し、ローカルと CI が production build の preview を同じ経路で E2E 検証する。
- [x] #13: PR/main push で frozen install、lint、format check、typecheck、unit、build、E2E、dependency audit、gitleaks を最小権限で実行する。Actions は commit SHA 固定で、E2E 失敗 artifact のみ保存する。
- [x] #9: `CsvInputLimits` と既定値を core から公開し、上限超過が atomic failure になる。CSV formula injection を抑止し、未知列の名前・順序・値を保持する。RDF predicate IRI と YAML の特殊文字出力が安全で unit test がある。
- [x] #6: `rdf-validate-shacl` で生成後 RDF と `schema/building_model.shacl.ttl` を検証し、focus node、result path、severity、constraint component、message を `Issue` に保持する。schema で使用する SHACL Core 制約を検証し、RDF/YAML で結果が一致する。
- [x] #7: Theme/CssBaseline、MUI AppBar/Toolbar/Paper/Dialog/Drawer、Zustand、SimpleTreeView/TreeItem、DataGrid に統一する。system font を使い、CSV 全列を表示し、編集確定と Tree 再構築後の選択・展開・フォーカスを E2E で保証する。
- [x] #10: UI が output plugin registry のみを使い、`OutputPlugin.run` と `runOutputPlugin` が `Promise<OutputPluginResult>` を返す。全形式の選択・download・進行中・失敗処理を統一し、validation error と serializer 例外時は download しない。
- [x] #12: README に機能、CSV 仕様と上限、未知列、検証、出力、対応ブラウザ、起動方法、制約、公開ポリシーと関連文書への導線がある。ブラウザ内処理、外部 font 通信なし、Pages の静的配信を明記する。
- [x] #11: production base が `/smartbuilding_datamodel_builder/`、development base が `/` で、main の CI 成功後のみ公式 Pages Actions から deploy される。subpath build の主要フローと外部通信なしを smoke test で確認する。

#### 最終公開ゲート
- [x] `pnpm install --frozen-lockfile`
- [x] `pnpm lint`
- [x] `pnpm format:check`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `pnpm test:e2e`
- [x] dependency audit（high/critical 0 件）
- [x] gitleaks（全履歴）
- [ ] Issue #5〜#15 の受入基準と Pages smoke test を確認し、M4 を Completed にして Issue #16 を閉じる

ローカルの Pages 相当 subpath smoke test までは完了。実際の deployed smoke test と Issue #16 の close は、変更の main 反映と Pages deploy 後に実施する。

## 4. タスクバックログ（優先順）

0) E2E 実行前提の明文化
- 目的: Playwright のブラウザインストール/依存パッケージの前提をREADMEとscriptsに明記する
- 変更対象（パス）: `README.md`, `package.json`, `apps/web/package.json`
- 受入基準:
  - [ ] README に「Playwright のブラウザ/依存導入」手順がある
  - [ ] package.json に Playwright 導入の補助スクリプトがある
- 実行すべきコマンド（最低限）: 省略可（ドキュメントのみ）

0.5) SHACL 検証の参照ファイル修正（building_model.shacl.ttl） (Done)
- 目的: RDF 検証で誤った SHACL ファイルを参照している問題を解消する
- 変更対象（パス）: `packages/core/src`, `packages/core/test`, `apps/web/e2e`, `schema/`
- 受入基準:
  - [x] SHACL 検証が `schema/building_model.shacl.ttl` を参照する
  - [x] 既知の違反ケースで violation が返ることを unit で確認できる
  - [x] E2E の SHACL エラー表示が参照ファイル修正後も安定している
- 実行すべきコマンド（最低限）: `pnpm test`, `pnpm test:e2e`

1) リポジトリの起動確認
- 目的: 既存の起動導線を確認し、作業の前提を固める
- 変更対象（パス）: 変更なし
- 受入基準:
  - [ ] `pnpm dev` でアプリが起動する
  - [ ] ブラウザで初期画面が表示される
- 実行すべきコマンド（最低限）: `pnpm dev`

2) OWL の確認（オントロジー把握）
- 目的: 出力対象となるオントロジーの主要クラス/プロパティを把握する
- 変更対象（パス）: `schema/` 配下（例: `schema/building_model.owl.ttl`）
- 受入基準:
  - [ ] 主要クラスと必須プロパティが一覧化できる
- 実行すべきコマンド（最低限）: 省略可

3) Core の CSV パース入口の確認
- 目的: CSV のパースとデータ構造の基点を把握する
- 変更対象（パス）: `packages/core/src/index.ts`
- 受入基準:
  - [ ] 主要エクスポートが理解できるコメント/README がある
  - [ ] unit テストの対象が特定できる
- 実行すべきコマンド（最低限）: `pnpm test`

4) fixtures の内容精査
- 目的: テスト CSV の列構成と未知列の有無を把握する
- 変更対象（パス）: `packages/fixtures`
- 受入基準:
  - [ ] 主要 fixture の列一覧が確認できる
- 実行すべきコマンド（最低限）: `pnpm test`

5) CSV 読み込みの UI 入口を確認
- 目的: UI 側の読み込み経路を理解する
- 変更対象（パス）: `apps/web/src/App.tsx`
- 受入基準:
  - [ ] 読み込みアクションの入口が把握できる
- 実行すべきコマンド（最低限）: `pnpm dev`

6) Tree 表示の最小確認
- 目的: Tree が CSV に基づいて描画されることを担保
- 変更対象（パス）: `apps/web/src/App.tsx`, `apps/web/src/state/store.ts`
- 受入基準:
  - [ ] CSV 読み込み後に Tree にノードが表示される
  - [ ] 空 CSV でクラッシュしない
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test:e2e`

7) DataGrid 表示の最小確認
- 目的: DataGrid が CSV に基づいて描画されることを担保
- 変更対象（パス）: `apps/web/src/App.tsx`
- 受入基準:
  - [ ] CSV 読み込み後に行と列が表示される
  - [ ] 未知列が列として表示される
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test:e2e`

8) Tree 選択と DataGrid 同期
- 目的: Tree 選択がグリッド選択/フィルタに反映される
- 変更対象（パス）: `apps/web/src/App.tsx`, `apps/web/src/state/store.ts`
- 受入基準:
  - [ ] Tree のノード選択で DataGrid の行が絞り込まれる
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

9) CSV 未知列の保持確認（core）
- 目的: CSV の未知列が破壊されないことを保証
- 変更対象（パス）: `packages/core/src`, `packages/core/test/core.test.ts`
- 受入基準:
  - [ ] 未知列を含む CSV がラウンドトリップで保持される
- 実行すべきコマンド（最低限）: `pnpm test`

10) Validation の最小ケース追加
- 目的: バリデーション（zod + 参照整合）の最小例を固定
- 変更対象（パス）: `packages/core/src`, `packages/core/test/core.test.ts`
- 受入基準:
  - [ ] 不正な参照でエラーが返る
  - [ ] 正常ケースが通る
- 実行すべきコマンド（最低限）: `pnpm test`

11) オントロジー対応のマッピング設計
- 目的: CSV/Tree モデルから OWL へのマッピング方針を定義する
- 変更対象（パス）: `schema/`, `README.md`（または設計メモ）
- 受入基準:
  - [ ] クラス/プロパティ対応表が明文化される
- 実行すべきコマンド（最低限）: MAY 省略（理由記載）

11.1) 空間/機器/ポイントの関係マッピング追加
- 目的: CSV 読み込み時の親子関係を RDF 出力に反映する
- 変更対象（パス）: `packages/core/src`, `packages/core/test`
- 受入基準:
  - [ ] Site は `hasPart` で子 Building の ID を参照する
  - [ ] Building は `hasPart` で子要素（例: Room など）の ID を参照する
  - [ ] EquipmentExt は `locatedIn` で親空間（CSV の `parentId` 相当）を参照する
  - [ ] PointExt は `hasPoint` で空間または EquipmentExt への関係を持つ
  - [ ] unit テストで最小ケースを検証する
- 実行すべきコマンド（最低限）: `pnpm test`

12) RDF 生成の最小実装（core）
- 目的: OWL に従った RDF を生成できるようにする
- 変更対象（パス）: `packages/core/src`
- 受入基準:
  - [ ] 代表 fixture から RDF が生成される
- 実行すべきコマンド（最低限）: `pnpm test`

13) RDF シリアライズ形式の決定
- 目的: 出力形式（Turtle/JSON-LD など）を決める
- 変更対象（パス）: `README.md`, `packages/core/src`
- 受入基準:
  - [ ] 出力形式と拡張子が明記される
- 実行すべきコマンド（最低限）: MAY 省略（理由記載）

14) YAML 出力の最小実装
- 目的: RDF と整合する YAML を生成する
- 変更対象（パス）: `packages/core/src`
- 受入基準:
  - [ ] RDF と内容が一致する YAML が生成される
- 実行すべきコマンド（最低限）: `pnpm test`

15) UI での検証結果表示（最小）
- 目的: 検証結果が UI で確認できる
- 変更対象（パス）: `apps/web/src/App.tsx`, `apps/web/src/state/store.ts`
- 受入基準:
  - [ ] エラー数が画面に表示される
  - [ ] 1 つ以上のエラー詳細が確認できる
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

16) DataGrid 編集 → state 反映
- 目的: 編集した値が state に反映される
- 変更対象（パス）: `apps/web/src/App.tsx`, `apps/web/src/state/store.ts`
- 受入基準:
  - [ ] セル編集後、再描画しても値が保持される
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

17) DataGrid 編集 → RDF/YAML 反映
- 目的: 編集結果が RDF/YAML 出力に含まれる
- 変更対象（パス）: `packages/core/src`, `apps/web/src/App.tsx`
- 受入基準:
  - [ ] 変更した値が RDF と YAML 出力に含まれる
- 実行すべきコマンド（最低限）: `pnpm test`, `pnpm test:e2e`

18) RDF 出力（ダウンロード）
- 目的: UI から RDF を保存できる
- 変更対象（パス）: `apps/web/src/App.tsx`
- 受入基準:
  - [ ] 保存操作で RDF がダウンロードされる
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

19) YAML 出力（ダウンロード）
- 目的: UI から YAML を保存できる
- 変更対象（パス）: `apps/web/src/App.tsx`
- 受入基準:
  - [ ] 保存操作で YAML がダウンロードされる
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

20) Playwright: 読み込み E2E 追加
- 目的: 読み込みの回帰を防ぐ
- 変更対象（パス）: `apps/web/e2e/app.spec.ts`
- 受入基準:
  - [ ] CSV 読み込み後に Tree と DataGrid が表示される
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

21) Playwright: 編集 → RDF 出力 E2E 追加
- 目的: 編集フローの回帰を防ぐ
- 変更対象（パス）: `apps/web/e2e/app.spec.ts`
- 受入基準:
  - [ ] DataGrid を編集し、RDF 出力まで完了する
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

22) Playwright: 編集 → YAML 出力 E2E 追加
- 目的: 編集フローの回帰を防ぐ
- 変更対象（パス）: `apps/web/e2e/app.spec.ts`
- 受入基準:
  - [ ] DataGrid を編集し、YAML 出力まで完了する
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

23) E2E 安定化（data-testid 付与）
- 目的: セレクタ依存による不安定化を回避
- 変更対象（パス）: `apps/web/src/App.tsx`, `apps/web/e2e/app.spec.ts`
- 受入基準:
  - [ ] E2E の主要要素が `data-testid` で参照できる
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

24) Tree 選択保持の回帰テスト
- 目的: 再構築時に選択状態が失われないことを担保
- 変更対象（パス）: `apps/web/e2e/app.spec.ts`
- 受入基準:
  - [ ] CSV 再読み込み後も選択状態が維持される
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

25) 大規模 CSV の単体ベンチ（簡易）
- 目的: パフォーマンス劣化の早期検知
- 変更対象（パス）: `packages/core/test/core.test.ts`, `packages/fixtures`
- 受入基準:
  - [ ] 大規模 CSV のパースがタイムアウトしない
- 実行すべきコマンド（最低限）: `pnpm test`

26) エラー UX の最小改善
- 目的: エラー位置が分かる UI を用意する
- 変更対象（パス）: `apps/web/src/App.tsx`
- 受入基準:
  - [ ] エラーのある行が視覚的に分かる
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

27) 検索（Tree/グリッドどちらか）
- 目的: 最小の検索体験を提供する
- 変更対象（パス）: `apps/web/src/App.tsx`
- 受入基準:
  - [ ] キーワード入力で該当行が絞り込まれる
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

28) RDF/YAML 仕様のドキュメント整備
- 目的: 出力形式と語彙が明確になる
- 変更対象（パス）: `README.md` または `schema/` 配下
- 受入基準:
  - [ ] 主要クラス/プロパティと出力例が記載されている
- 実行すべきコマンド（最低限）: MAY 省略（理由記載）

29) E2E 失敗の根本原因修正（fixture 拡充 + ID 期待値調整）
- 目的: E2E テストが実際の Tree 構築実装と fixture データに整合するよう修正する
- 背景:
  - 実装調査により、以下の不整合が判明した:
    1. Tree ID 生成: `tree.ts` の `buildHierarchyTree()` は slug ベースの ID（例: `"site:tokyo-site1"`, `"building:site:tokyo-site1/main-bldg"`）を生成する。
    2. E2E 期待値: テストは numeric suffix ID（例: `"site-1"`, `"bldg-1"`, `"floor-1"`, `"space-1"`）を期待している。
    3. Fixture 不足: `valid.csv` は 2 行のみで、単一階層（TokyoSite1 > MainBldg > 3F > Room101）しか含まれていない。テストが期待する複数の site/building/floor/space は存在しない。
    4. バリデーションメッセージ: テストは `"Duplicate id"` を期待するが、実装は `"Duplicate id: ${id}"` を返す。
- 修正方針:
  1. Fixture 拡充（`packages/fixtures/valid.csv`）
     - 複数の site/building/floor/room を含む行を追加する。
     - E2E テストが期待する検索キーワード（例: "Room 201"）に対応するデータを含める。
  2. E2E テスト ID 期待値の調整（`apps/web/e2e/app.spec.ts`）
     - 生成される実際の ID（slug ベース）を反映した `data-testid` を使用するように修正する。
     - または、fixture データの site/building/floor/room 名を調整して、生成される ID が単純化されるようにする（例: site 名を "Site1" にすることで `"site:site1"` が生成される）。
  3. バリデーションメッセージ期待値の修正
     - テストの期待メッセージを `"Duplicate id: PT001"` のように具体的な形式に修正する。
- 変更対象（パス）: `packages/fixtures/valid.csv`, `packages/fixtures/invalid.csv`, `apps/web/e2e/app.spec.ts`
- 受入基準:
  - [ ] `valid.csv` に複数の site/building/floor/room が含まれる（最低でも site 2 つ、building 各 1 つ、floor 各 1 つ、room 各 1 つ）
  - [ ] `valid.csv` に "Room 201" を含む行が存在する（検索テスト用）
  - [ ] E2E テストの `data-testid` 期待値が実際に生成される ID と一致する
  - [ ] `invalid.csv` のバリデーションメッセージテストが通る
  - [ ] `pnpm test:e2e` で 18 テスト中少なくとも 15 テストが通る
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

29-2) fixture 更新時のルール明文化
- 目的: テストデータの品質を維持する
- 変更対象（パス）: `packages/fixtures/README.md`（なければ作成）
- 受入基準:
  - [ ] fixture の更新方法が記載されている
- 実行すべきコマンド（最低限）: `pnpm test`

30) E2E の待機改善
- 目的: 不安定な待機を除去
- 変更対象（パス）: `apps/web/e2e/app.spec.ts`
- 受入基準:
  - [ ] `waitForTimeout` を使っていない
  - [ ] `locator/expect` ベースで安定している
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

31) CSV 読み込み → データモデル生成（JSON Schema 構造）ユニットテスト
- 目的: CSV 読み込み後に期待する階層構造/プロパティが正しくマッピングされることを担保する
- 変更対象（パス）: `packages/core/src`, `packages/core/test`
- 受入基準:
  - [ ] `schema/building_model.schema.json` の定義に沿った階層構造が生成される
  - [ ] CSV 列が期待プロパティにマッピングされる
  - [ ] snake_case は lowerCamel に変換される
  - [ ] 既に lowerCamel の列名はそのままマッピングされる
- 実行すべきコマンド（最低限）: `pnpm test`

32) デバイステンプレート管理ビュー追加
- 目的: デバイス種別一覧とテンプレート管理 UI を追加する
- 変更対象（パス）: `apps/web/src`
- 受入基準:
  - [ ] CSV 由来のデバイス種別一覧が表示される
  - [ ] テンプレートの読み込み/生成が可能
  - [ ] 差分（齟齬）が UI に表示される
  - [ ] ZIP 出力操作が可能
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`

33) デバイステンプレート生成/検証/ZIP 出力（core）
- 目的: テンプレート生成と差分検証、ZIP 出力を core に実装する
- 変更対象（パス）: `packages/core/src`, `packages/core/test`
- 受入基準:
  - [ ] CSV からテンプレートが生成される
  - [ ] 既存テンプレートとの差分が検出できる
  - [ ] テンプレート群を ZIP で出力できる
- 実行すべきコマンド（最低限）: `pnpm test`

34) デバイステンプレート E2E 追加
- 目的: テンプレート管理フローの回帰を防ぐ
- 変更対象（パス）: `apps/web/e2e`
- 受入基準:
  - [ ] デバイス種別一覧表示 → テンプレート生成/読込 → ZIP 出力が完了する
- 実行すべきコマンド（最低限）: `pnpm test:e2e`

35) デバイステンプレート継承（Base）導入 (Done)
- 目的: テンプレートに継承関係を追加し Base を選択可能にする
- 変更対象（パス）: `packages/core/src`, `packages/core/test`, `apps/web/src`
- 受入基準:
  - [ ] Base テンプレートが namespace ごとに生成される
  - [ ] 継承（extends）が解決され、共通プロパティが反映される
  - [ ] UI で Base/継承元を選択できる
  - [ ] 循環継承がエラーとして検出される
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`

36) 出力プラグイン化（フォーマット/シリアライズ選択） (Done)
- 目的: 出力形式をプラグイン化し、UI で選択・出力できるようにする
- 変更対象（パス）: `packages/core/src`, `packages/core/test`, `apps/web/src`
- 受入基準:
  - [ ] 出力プラグインのレジストリが実装される
  - [ ] フォーマット/シリアライズの選択 UI がある
  - [ ] 既存 RDF/YAML 出力がプラグイン経由で動作する
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`

37) 空間/機器リソースの編集対象拡張 (Done)
- 目的: Tree で空間/機器を選択してデータモデルを編集できるようにする
- 変更対象（パス）: `packages/core/src`, `packages/core/test`, `apps/web/src`
- 受入基準:
  - [ ] 空間/機器のリソースが抽出・表示される
  - [ ] 選択ノード種別に応じたプロパティが編集できる
  - [ ] 既存のポイント編集と共存する
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`

38) 出力時の編集反映と SHACL 検証 (Done)
- 目的: 編集プロパティ/デフォルト値の出力反映と SHACL 検証を追加する
- 変更対象（パス）: `packages/core/src`, `packages/core/test`, `apps/web/src`, `schema/`
- 受入基準:
  - [ ] 編集で追加/変更したプロパティが RDF/YAML に反映される
  - [ ] デフォルト値は空欄のときのみ補完される
  - [ ] 空欄プロパティは出力からオミットされる
  - [ ] SHACL 検証が出力時に実行され、違反が Issue として返る
  - [ ] UI で SHACL 違反が確認できる
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`

39) MUI レイアウト統一（余白・密度・整列）
- 目的: 余白・密度・整列を 8px グリッド（theme.spacing）で統一し、プロダクト品質のレイアウトにする。機能と状態管理は一切変更せず、見た目のみ改善する。
- 変更対象（パス）: `apps/web/src/theme.ts`（新規）, `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- 受入基準:
  - [ ] margin/padding/gap は theme.spacing 系のみ
  - [ ] toolbar の1行目/2行目の高さと要素整列が揃っている（ガタつきがない）
  - [ ] panel の内側余白が一定で、Tree と Grid の上端が揃う
  - [ ] DataGrid が panel 内で自然に伸び、余白が均一
  - [ ] 動作・機能は変わっていない（E2E が通る）
- 実装タスク:
  - A) `apps/web/src/theme.ts` を作成し、createTheme を App.tsx から移動。shape.borderRadius=8、MuiButton/TextField/Alert/Chip/DataGrid の components overrides を追加
  - B) App.tsx に AppShell 相当の構造を導入（padding/gap を theme.spacing で統一）
  - C) toolbar を 2 行 Stack 構成に整理（1行目：タイトル+CSV操作+出力選択、2行目：ビュー+サイズ+検証概要）、spacing/flexWrap を統一
  - D) main を CSS grid 化（grid-template-columns: 320px 1fr、gap: theme.spacing(2)）、panel を Paper variant="outlined" + padding: theme.spacing(2) に統一
  - E) styles.css の余白関連 className を削減し、状態表現クラス（row-error 等）のみ残す
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test:e2e`

40) Issue #30: PointExt の `building` を `sbco:building` として RDF 出力 (Done)
- 目的: ポイントリスト CSV の `building` 列を未知プロパティではなく SBCO 正規述語として出力し、Building OS 側でポイントの Building メタデータを解決できるようにする。
- 背景:
  - `packages/core/src/rdf.ts` の `SBCO_FIELDS` に `building` がなく、`predicateFor()` が `<https://www.sbco.or.jp/ont/property/building>` へフォールバックする。
  - Building OS は `sbco:building` を参照するため、現状ではテレメトリ保存時の Parquet パーティションが `building_id=unknown` になる。
- 変更対象（パス）: `packages/core/src/rdf.ts`, `packages/core/test/core.test.ts`
- 実装タスク:
  - A) `SBCO_FIELDS` に `building` を追加し、CSV ヘッダー正規化後の `building` を `sbco:building` にマッピングする。
  - B) `exportRdf()` の回帰テストで、`building=THX` を持つ PointExt に `sbco:building "THX"` が出力され、未知プロパティ IRI の `property/building` が出力されないことを確認する。
  - C) RDF output plugin（`runOutputPlugin('RDF', 'Turtle', ...)`）の回帰テストで同じ述語マッピングを確認する。
  - D) 既存の未知列（例: `extra`）が引き続き `UNKNOWN_PROPERTY_BASE` 配下へ出力されることをテストで明示する。
- 受入基準:
  - [ ] `building=THX` を含む CSV から、PointExt に `sbco:building "THX"` が生成される
  - [ ] `<https://www.sbco.or.jp/ont/property/building>` は生成されない
  - [ ] 既存の未知フィールドは引き続き `UNKNOWN_PROPERTY_BASE` 配下へ出力される
  - [ ] RDF の直接出力経路と RDF output plugin 経路の双方に回帰テストがある
  - [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test` が成功する
- 非目標:
  - CSV の階層構築、Building リソース（`rec:Building`）の生成ロジック、および UI/E2E の変更は行わない
- 実行すべきコマンド（最低限）: `pnpm lint`, `pnpm typecheck`, `pnpm test`

## 5. リスクと軽減策
- DataGrid 編集の罠
  - [ ] `processRowUpdate` と編集イベントの差分を把握する
  - [ ] 編集後の state 反映を unit/E2E で固定する
- 大規模 CSV の性能
  - [ ] パースと Tree 構築を分離し、必要なら遅延/バッチ化する
  - [ ] 代表サイズの fixture を追加して簡易ベンチを持つ
- RDF/OWL の不整合
  - [ ] OWL のクラス/プロパティと CSV 列の対応表を維持する
  - [ ] 生成 RDF の最小バリデーション（必須プロパティの有無）を unit で固定する
- E2E の不安定化（selector/待機）
  - [ ] `data-testid` を必須化
  - [ ] `locator/expect` で待機する

## 6. 将来拡張（Backlog: Future）
- [ ] drag&drop で親変更
- [ ] schema（JSON Schema/LinkML）連携
- [ ] Tauri 化
- [ ] IFC/DTDL/RDF 以外の外部フォーマットへのエクスポート
