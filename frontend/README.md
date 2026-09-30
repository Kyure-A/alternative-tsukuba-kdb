# alternative-tsukuba-kdb/frontend

筑波大学 KdB っぽいなにかのフロントエンドです。React、TypeScript、Vite、Emotion を用いて構築しています。

## TWINS と同期するローカル版

Node.js 24 以降、Yarn、Nix、およびログイン済みの
[twins-cli](https://github.com/Kyure-A/twins-cli) セッションを使用します。

```bash
cd frontend
yarn install --frozen-lockfile
yarn twins
```

[http://127.0.0.1:4317/alternative-tsukuba-kdb/](http://127.0.0.1:4317/alternative-tsukuba-kdb/)
を開くと、全8モジュールの履修情報を自動取得して既存の時間割へ反映します。
再読み込みのたびに TWINS から取得します。取得が一部でも失敗した場合は
既存の履修案を保持します。通常の `yarn dev` と GitHub Pages は静的版です。

科目の星印で履修案を編集し、時間割下部の **TWINS に反映** を押すと、
表示中のモジュールに対する追加・取消の差分を確認できます。取消は初期状態で
未選択です。実行する変更と TWINS の表示年度を確認してから反映します。
複数モジュールの授業も1科目として操作し、実行後は全8モジュールを再照会します。

履修案のメモ・別年度の履修・TA 設定は保持します。再読み込み時には新たに
登録された科目を取り込み、編集中の追加・取消案は保持します。TWINS 側で
消えた科目を履修案から自動削除しないため、履修案と登録済み情報が異なる場合は
書き戻しの差分で確認してください。KdB にない科目も TWINS の時限で表示します。

集中・応談や日時が確定しない科目、休業期間の登録、抽選・年間上限の強制解除は
書き戻しの対象外です。TWINS の登録期間外・取消不可の科目も操作できません。
現在の KdB データは2026年度です。TWINS CLI には対象年度の構造化された取得が
ないため、書き戻す年度は TWINS の画面でも確認してください。

連携サーバーは `127.0.0.1` のみに待ち受け、同一オリジンの JSON リクエストを
受け付けます。パスワードや Cookie をブラウザーへ返しません。
CLI は `github:Kyure-A/twins-cli/13367cec6fc82ee8ba07c7289c6b78c1657446ab`
に固定しています。失敗した書き込みは自動再試行せず、途中停止と結果不明を
区別します。操作記録は Git 管理外の `.twins-state.local/operations.jsonl`
に保存します。登録情報はブラウザー内の既存の履修案として保存されます。

```bash
# 実際の TWINS を変更しないテスト
yarn test
yarn build
# ビルド済みの画面を起動
yarn twins:serve
```

科目データは本家の2026年9月30日版（`41000f16b0a6524e325ae3cd04c3223431f49136`）
から更新しています。

## 開発

```bash
# 環境構築
yarn

# 開発用サーバを起動：http://localhost:5173/alternative-tsukuba-kdb/
yarn run dev

# lint, フォーマット
yarn run check

# ビルド
yarn run build
```
