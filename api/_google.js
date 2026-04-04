// ============================================
// Google API 共通設定ファイル
// 全APIファイルから共有して使う認証・接続設定です。
// ファイル名が「_」で始まるため、Vercelはこれを
// APIエンドポイントとしては公開しません。
// ============================================

const { google } = require('googleapis');

// サービスアカウントの認証情報を環境変数から読み込む
function getAuth(scopes) {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: scopes,
  });
}

// Google Sheets API クライアントを取得
function getSheetsClient() {
  const auth = getAuth([
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  return google.sheets({ version: 'v4', auth });
}

// Google Drive API クライアントを取得（ドキュメントのHTML書き出しに使用）
function getDriveClient() {
  const auth = getAuth([
    'https://www.googleapis.com/auth/drive.readonly',
  ]);
  return google.drive({ version: 'v3', auth });
}

// スプレッドシートID
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

module.exports = {
  getSheetsClient,
  getDriveClient,
  SPREADSHEET_ID,
};
