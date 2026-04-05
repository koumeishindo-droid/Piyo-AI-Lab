// ============================================
// Vercel サーバーレス関数: /api/articles
// Google スプレッドシートから記事一覧を取得し、
// 各記事のGoogleドキュメントをHTML形式で取得して
// メインWEB（index.html）に渡す中継役です。
//
// 【Notion版からの変更点】
// ・データソースをNotionからGoogleスプレッドシートに変更
// ・記事本文をGoogleドキュメントからHTML書き出しで取得
// ・画像はGoogleのCDN経由で配信（URLが安定して消えない）
// ============================================

const { getSheetsClient, getDriveClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  // どのドメインからでもデータを取得できるようにする設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const sheets = getSheetsClient();

    // ============================================
    // スプレッドシートの「記事管理」シートからデータ取得
    // ============================================
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: '記事管理!A2:M',  // ヘッダー行を除いた2行目以降
    });

    const rows = response.data.values || [];

    // 各行を記事オブジェクトに変換
    // スプレッドシートの列構成:
    // A:タイトル B:執筆者 C:カテゴリ D:レベル E:日付
    // F:概要 G:サムネイル背景 H:サムネイル画像URL
    // I:GoogleドキュメントID J:閲覧数 K:評価データ
    // L:平均評価 M:評価数
    const articles = await Promise.all(
      rows
        .filter(row => row[0]) // タイトルが空の行はスキップ
        .map(async (row, index) => {
          const docId = row[8] || '';  // GoogleドキュメントID
          let content = '';

          // GoogleドキュメントIDがあれば本文をHTMLで取得
          if (docId) {
            content = await getDocContent(docId);
          }

          const level = row[3] || '';

          return {
            id: `row-${index + 2}`,  // スプレッドシートの行番号（2行目始まり）
            title: row[0] || '',
            author: row[1] || '',
            category: row[2] || '',
            level: level,
            levelLabel: getLevelLabel(level),
            excerpt: row[5] || '',
            content: content,
            thumb: row[6] || '',
            thumbImage: row[7] || '',
            date: row[4] || '',
            views: Number(row[9]) || 0,
            ratings: JSON.parse(row[10] || '[]'),
          };
        })
    );

    // 日付の降順でソート（新しい記事が先）
    articles.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.localeCompare(a.date);
    });

    res.status(200).json({ articles });
  } catch (error) {
    console.error('Google API エラー:', error);
    res.status(500).json({ error: 'データの取得に失敗しました' });
  }
};

// ============================================
// Googleドキュメントの本文をHTML形式で取得
//
// Google Drive APIの「書き出し」機能を使って、
// ドキュメントをHTMLに変換します。
// 画像はGoogleのCDN URLで配信されるため、
// Notionのように1時間で消えることはありません。
// ============================================

async function getDocContent(docId) {
  try {
    const drive = getDriveClient();

    // ドキュメントをHTML形式で書き出し
    const response = await drive.files.export({
      fileId: docId,
      mimeType: 'text/html',
    });

    const fullHtml = response.data;

    // Google Docsが出力するHTMLから<body>の中身だけを抽出
    const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let bodyContent = bodyMatch ? bodyMatch[1] : fullHtml;

    // Google Docsが付けるスタイル属性を一部クリーンアップ
    // （サイトのデザインと競合する可能性があるため）
    bodyContent = cleanGoogleDocsHtml(bodyContent);

    return bodyContent;
  } catch (error) {
    console.error(`ドキュメント取得エラー (ID: ${docId}):`, error.message);
    return '';
  }
}

// ============================================
// Google DocsのHTMLをクリーンアップ
// 不要なラッパーやスタイルを整理して、
// サイトのデザインに馴染むようにします。
// ============================================

function cleanGoogleDocsHtml(html) {
  // Google Docsのデフォルトスタイルタグを除去
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // 空のspanタグを除去
  html = html.replace(/<span\s*>\s*<\/span>/gi, '');

  // Google Docsが各段落に付ける class 属性はそのまま残す
  // （必要に応じてCSSで制御できるように）

  // 画像のスタイルを調整（レスポンシブ対応）
  html = html.replace(
    /<img([^>]*?)style="([^"]*)"([^>]*?)>/gi,
    '<img$1style="max-width:100%; height:auto;"$3>'
  );

  // style属性のないimgタグにもレスポンシブスタイルを追加
  html = html.replace(
    /<img(?![^>]*style=)([^>]*?)>/gi,
    '<img style="max-width:100%; height:auto;"$1>'
  );

  return html;
}

// ============================================
// レベルラベルの変換（Notion版と同じ）
// ============================================

function getLevelLabel(level) {
  const labels = {
    beginner: 'ひよこ',
    intermediate: '育ちざかり',
    advanced: 'にわとり',
  };
  return labels[level] || level;
}
