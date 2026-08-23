# @repo/cli

`apps/web` の UI を使わずに、CSV ファイルを `packages/core` の出力プラグインでフォーマット変換するためのコマンドラインツール。CSV パース・バリデーション・各フォーマットへのシリアライズは `@repo/core` をそのまま利用しており、このパッケージ自体は引数解析とファイル入出力の配線のみを行う。

## 使い方

リポジトリルートから:

```sh
pnpm cli -- --input <csv> --format <format> [--serializer <name>] [--out <path>] [--allow-issues]
pnpm cli -- --list-formats
```

- `--input <path>`: 入力CSVファイル（必須。`--list-formats` 指定時は不要）。CSVの列仕様は `pointlist.md` を参照。
- `--format <name>`: 出力フォーマット。`CSV` / `JSON` / `JSON-LD` / `RDF` / `YAML` / `DTDL` / `WoT` のいずれか。
- `--serializer <name>`: `DTDL`（`Interfaces` / `Twin Graph`）や `WoT`（`Thing Description` / `Thing Model`）のように同一フォーマットに複数のシリアライザがある場合に指定する。省略時、一意に定まらなければエラーになり選択肢が表示される。
- `--out <path>`: 出力ファイルパス。省略時は標準出力に書き出す。
- `--allow-issues`: RDF/YAML/WoT 出力で SHACL/スキーマ違反（blocking issue）があっても書き込みを続行する。省略時は違反があると書き込みをブロックし、終了コード `1` を返す（`apps/web` の「violation があればダウンロードしない」挙動と同じ）。
- `--list-formats`: 利用可能な `--format`/`--serializer` の組み合わせを一覧表示して終了する。

CSVの構造的な検証結果（重複ID、親参照不整合など）は常に標準エラー出力に警告として表示される（書き込みはブロックしない）。

## 入力上限

`@repo/core` の `parseCsv` は既定で以下の上限を持つ。これは `apps/web` が CSV パース・Tree 構築・検証・SHACL をすべてメインスレッドで実行するために設けられた既定値であり、CLI にはその制約がないため上限を引き上げられる。

| 対象 | オプション | 既定値 |
| --- | --- | ---: |
| ファイルサイズ（バイト） | `--max-bytes <n>` | 5242880（5 MiB） |
| データ行 | `--max-rows <n>` | 20000 |
| 列 | `--max-columns <n>` | 100 |
| 1 セル（UTF-8 バイト） | `--max-cell-bytes <n>` | 32768（32 KiB） |

いずれも正の整数のみを受け付け、それ以外を渡すと終了コード `2` になる。上限を超えた入力は `CsvInputLimitError` として終了コード `2` で拒否される。

CSV は一括で読み込んでからパースする（ストリーミングではない）ため、上限を大きく引き上げるとメモリと実行時間がそれなりに必要になる。実測値の目安として、34,895 行 / 4.8 MiB のポイントリストを `--format RDF --serializer Turtle`（SHACL 検証込み）で変換した場合、約 90 秒・ピーク RSS 約 4.2 GB を要した。Node.js の既定ヒープ上限に収まらない場合は `NODE_OPTIONS=--max-old-space-size=8192` などを併用する。

## 出力の件数照合

RDF / YAML / DTDL / WoT / Tree JSON は Tree から生成するため、階層を解決できない行（`site` / `building` / `floor` が未設定、または Point があって `device_id` / `device_name` がいずれも未設定）は出力に一切含まれない。CLI は出力前に必ず次の行を標準エラー出力へ書き出す。

```
Rows read: 34895 -> rows in output: 31364 (dropped: 3531); resources emitted: 72850
```

出力に含まれない行があれば `row_dropped`（`violation`）として報告し、既定では書き込みをブロックして終了コード `1` を返す。SHACL の結果が、出力から外れた行を見ないまま「violation 0 件」になることを防ぐための fail-closed である。承知の上で書き出す場合は `--allow-issues` を指定する。

`installation_area` が未設定で Equipment が Level 直下になる行は `buildingos_room_missing`（`warning`）として報告する。RDF としては妥当なため書き込みはブロックしないが、ビルOS はこの階層を受理しない。

行単位の Issue は先頭 200 件で打ち切るが、サマリの Issue には常に正確な総数と省略件数が入る。

### 例

```sh
# サンプルCSVをTurtle(RDF)に変換してファイルへ出力
pnpm cli -- --input sample/debug-sample.csv --format RDF --serializer Turtle --out out.ttl

# YAMLに変換して標準出力へ
pnpm cli -- --input sample/debug-sample.csv --format YAML

# 利用可能なフォーマット一覧
pnpm cli -- --list-formats

# Web UI の入力上限を超える大規模ポイントリスト
pnpm cli -- --input large-pointlist.csv --format RDF --serializer Turtle \
  --max-rows 40000 --max-bytes 20971520 --out out.ttl
```

### 終了コード

- `0`: 成功
- `1`: 出力側のブロッキング検証（`row_dropped`、SHACL violation 等）で書き込みを中止
- `2`: 引数不正（上限オプションが正の整数でない場合を含む）、入力ファイル読み込み失敗、入力上限超過、CSVパースエラーなど

## 開発

```sh
pnpm --filter @repo/cli lint
pnpm --filter @repo/cli typecheck
pnpm --filter @repo/cli test
```
