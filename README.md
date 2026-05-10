# 運転日誌 PWA（フェーズ2 PoC）

GAS バックエンド（[`../unten_nisshi_poc/`](../unten_nisshi_poc/)）に対する PWA フロントエンド。
スマホでホーム画面に追加すれば、見た目はほぼネイティブアプリ。圏外でも入力できる。

## ファイル構成

| ファイル | 役割 |
|:---|:---|
| `index.html` | アプリ本体（テンプレートを含む単一HTML） |
| `app.css` | スタイル |
| `app.js` | ロジック（ルーター、API、IndexedDB、Service Worker登録） |
| `service-worker.js` | アプリシェルキャッシュ＝オフライン起動 |
| `manifest.json` | PWA 名前・アイコン・テーマ色 |
| `icon-192.png` / `icon-512.png` | ホーム画面アイコン |

## ローカルで動作確認する

### 方法 A: Python の簡易サーバ

```bash
cd unten_nisshi_pwa
python -m http.server 8765
# ブラウザで http://localhost:8765/ を開く
```

### 方法 B: ngrok などでスマホ実機テスト

```bash
python -m http.server 8765
ngrok http 8765
# 表示されたhttps URL をスマホで開く
```

> ⚠️ Service Worker は **HTTPS または localhost** でしか動かない。`file://` 直開きは不可。

## 使い方（初回）

1. PWA を開く
2. **初回設定** 画面が出る → GAS URL とトークンを入力
3. **接続テスト** ボタンで疎通確認
4. **保存** で次に進む
5. **入力者選択** 画面で自分の社員IDをタップ
6. 一覧画面が表示される（最新20件）
7. 下部 **新規** から運転日誌を入力

設定値はブラウザの localStorage に保存される。同じ端末・同じブラウザなら次回以降は素通し。

## デプロイ先候補

### A) GitHub Pages（無料・推奨）

1. GitHub に新規リポジトリ作成（例: `unten-nisshi-pwa`、Public）
2. 本フォルダの全ファイルを push
3. リポジトリの Settings → Pages → Branch を `main` に設定
4. 数分後に `https://<ユーザー名>.github.io/unten-nisshi-pwa/` で公開
5. このURLをスマホで開いて「ホーム画面に追加」

### B) Firebase Hosting（無料枠・カスタムドメイン可）

1. Firebase プロジェクト作成
2. `npm install -g firebase-tools`
3. `firebase login` → `firebase init hosting`（Public folder を本フォルダに指定）
4. `firebase deploy`
5. 発行された `https://<project>.web.app/` を使う

### C) 社内サーバ（Z ドライブ等の公開不可場所）

社外モバイル網からアクセスする要件があるため、**社内サーバはNG**。GitHub Pages または Firebase を使うこと。

## APK 化（Bubblewrap、後工程）

PWAが安定したら、Google公式 [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) で TWA (Trusted Web Activity) APK を生成できる。

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest=https://<your-pwa-url>/manifest.json
bubblewrap build
# unten-nisshi.apk が生成される
```

ただし TWA は**Digital Asset Links**を使ってドメイン所有を証明する必要があるため、独自ドメイン or GitHub Pages の正式手順に沿うこと。

## 注意・制限

| 項目 | 現状 | 改善方針 |
|:---|:---|:---|
| 社員マスタ | `STAFF_FALLBACK` にハードコード4名 | 社員マスタAPIを追加して動的取得 |
| 行先データ（1:N） | 未対応 | フォームに「行先」追加、子テーブル書き込みAPI実装 |
| アルコールチェック | 名前テキスト入力のみ | アルコールチェックマスタとRefにする |
| 認証 | SHARED_TOKEN（共有トークン） | Workspace導入後はOAuthに昇格 |
| バリデーション | 最低限 | 走行距離が異常値なら警告、メータ前回値チェックなど |
| アイコン | プレースホルダ（運の文字） | 正式デザインに差し替え |

## アンインストール手順（ローカルクリア）

設定画面の「ローカル全消去」ボタンで全データをクリア。
あるいはブラウザの設定からサイトデータ削除。

## 関連

- バックエンド: `../unten_nisshi_poc/` （Code.gs）
- プロジェクト全体: `Z:\全社共有\保管文書\Obsidian\02_Projects\1_総務\運転日誌_AppSheet脱却.md`
