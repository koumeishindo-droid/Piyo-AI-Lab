// ============================================
// Vercel サーバーレス関数: /api/articles
// Google スプレッドシートから記事一覧を取得し、
// 各記事のGoogleドキュメントをHTML形式で取得して
// メインWEB（index.html）に渡す中継役です。
// ============================================

const { getSheetsClient, getDriveClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  // どのドメインからでもデータを取得できるようにする設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 記事一覧を1時間キャッシュ（Vercel CDN）
  // 期限切れ後も60秒間は古いデータを返しつつ裏で更新
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=60');

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
    // 一覧では本文を取得しない（高速化のため）
    const articles = rows
      .filter(row => row[0]) // タイトルが空の行はスキップ
      .map((row, index) => {
        const level = row[3] || '';

        return {
          id: `row-${index + 2}`,  // スプレッドシートの行番号（2行目始まり）
          title: row[0] || '',
          author: row[1] || '',
          category: row[2] || '',
          level: level,
          levelLabel: getLevelLabel(level),
          excerpt: row[5] || '',
          thumb: row[6] || '',
          thumbImage: row[7] || '',
          date: row[4] || '',
          views: Number(row[9]) || 0,
          ratings: JSON.parse(row[10] || '[]'),
        };
      });

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
// 画像はGoogleのCDN URLで配信されます。
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

    // Google Docsが付けるスタイル・属性を徹底クリーンアップ
    bodyContent = cleanGoogleDocsHtml(bodyContent);

    return bodyContent;
  } catch (error) {
    console.error(`ドキュメント取得エラー (ID: ${docId}):`, error.message);
    return '';
  }
}

// ============================================
// Google DocsのHTMLをクリーンアップ
// 不要なラッパー・スタイル・属性を整理して、
// サイトのデザイン（Inter / Noto Sans JP / line-height:2）に
// しっかり馴染むようにします。
// ============================================

function cleanGoogleDocsHtml(html) {
  // ① <style>タグを完全除去（Google Docs既定の大量CSS）
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // ② class属性を除去（"c1" "c2" ...のような一意なクラス名）
  html = html.replace(/\sclass="[^"]*"/gi, '');

  // ③ id属性を除去（"h.abc123" など）
  html = html.replace(/\sid="[^"]*"/gi, '');

  // ④ Googleリダイレクトリンクを直リンクに変換
  //   https://www.google.com/url?q=https://example.com&sa=... → https://example.com
  html = html.replace(
    /href="https:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi,
    (m, url) => 'href="' + decodeURIComponent(url) + '"'
  );

  // ⑤ Google画像URLにサイズ制限を追加（幅800px、軽量化）
  html = html.replace(
    /(https:\/\/lh[0-9]*\.googleusercontent\.com\/[^"'\s>]+?)(?:=[^"'\s>]*)?(?=["'\s>])/gi,
    '$1=w800'
  );

  // ⑥ 画像タグを再構築（src/altのみ残し、レスポンシブ + 遅延読み込み）
  //   ※ ⑦のstyle一括除去より先に処理する
  html = html.replace(
    /<img([^>]*?)\/?>/gi,
    (m, attrs) => {
      const srcMatch = attrs.match(/src="([^"]*)"/i);
      const altMatch = attrs.match(/alt="([^"]*)"/i);
      const src = srcMatch ? srcMatch[1] : '';
      const alt = altMatch ? altMatch[1] : '';
      return '<img src="' + src + '" alt="' + alt + '" loading="lazy" style="max-width:100%;height:auto;">';
    }
  );

  // ⑦ すべての style 属性を除去（フォント・行間・マージン等を一掃）
  //   ⑥で <img> のスタイルは再付与済みなので、ここで他のタグの style を消す
  html = html.replace(/<(?!img)([a-z][a-z0-9]*)([^>]*?)\sstyle="[^"]*"([^>]*)>/gi, '<$1$2$3>');

  // ⑧ <span>タグをアンラップ（中身だけ残す。深いネスト対応で複数回）
  for (let i = 0; i < 5; i++) {
    html = html.replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, '$1');
  }

  // ⑨ 空の段落を除去
  //   <p></p>, <p>&nbsp;</p>, <p> </p>, <p><br></p> などを削除
  html = html.replace(/<p[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '');

  // ⑩ 連続する <br> を最大2つまでに制限
  html = html.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');

  // ⑪ 余分な空白行を整理
  html = html.replace(/\n{3,}/g, '\n\n');

  return html;
}

// ============================================
// レベルラベルの変換
// ============================================

function getLevelLabel(level) {
  const labels = {
    beginner: 'ひよこ',
    intermediate: '育ちざかり',
    advanced: 'にわとり',
  };
  return labels[level] || level;
}
