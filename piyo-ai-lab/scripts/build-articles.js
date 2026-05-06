// ============================================
// ビルド時に Google Sheets + Docs から全記事を取得し、
// public/ 配下に静的JSONとして書き出すスクリプト。
//
// 出力:
//   public/articles.json           ← 全記事の一覧（本文なし、軽量）
//   public/articles/row-N.json     ← 個別記事（本文込み）
//
// Vercelビルド時に `npm run build` で実行されます。
// ============================================

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ===== 認証 =====
function getAuth(scopes) {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes,
  });
}
const sheets = google.sheets({ version: 'v4', auth: getAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) });
const drive  = google.drive({ version: 'v3', auth: getAuth(['https://www.googleapis.com/auth/drive.readonly']) });
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// ===== Google Docs HTML クリーンアップ =====
function cleanGoogleDocsHtml(html) {
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/\sclass="[^"]*"/gi, '');
  html = html.replace(/\sid="[^"]*"/gi, '');
  html = html.replace(/href="https:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi,
    (m, url) => 'href="' + decodeURIComponent(url) + '"');
  html = html.replace(/(https:\/\/lh[0-9]*\.googleusercontent\.com\/[^"'\s>]+?)(?:=[^"'\s>]*)?(?=["'\s>])/gi, '$1=w800');
  html = html.replace(/<img([^>]*?)\/?>/gi, (m, attrs) => {
    const src = (attrs.match(/src="([^"]*)"/i) || [])[1] || '';
    const alt = (attrs.match(/alt="([^"]*)"/i) || [])[1] || '';
    return '<img src="' + src + '" alt="' + alt + '" loading="lazy" style="max-width:100%;height:auto;">';
  });
  html = html.replace(/<(?!img)([a-z][a-z0-9]*)([^>]*?)\sstyle="[^"]*"([^>]*)>/gi, '<$1$2$3>');
  for (let i = 0; i < 5; i++) html = html.replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, '$1');
  html = html.replace(/<p[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '');
  html = html.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
  html = html.replace(/\n{3,}/g, '\n\n');
  return html;
}

async function getDocContent(docId) {
  if (!docId) return '';
  try {
    const res = await drive.files.export({ fileId: docId, mimeType: 'text/html' });
    const bodyMatch = res.data.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return cleanGoogleDocsHtml(bodyMatch ? bodyMatch[1] : res.data);
  } catch (e) {
    console.error(`[WARN] doc取得失敗 (${docId}): ${e.message}`);
    return '';
  }
}

function getLevelLabel(level) {
  return ({ beginner: 'ひよこ', intermediate: '育ちざかり', advanced: 'にわとり' })[level] || level;
}

// ===== メイン処理 =====
(async () => {
  console.log('🐣 ビルド開始：Google Sheets から記事一覧を取得...');

  if (!SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    console.warn('⚠️  Google認証情報がありません。空のJSONを出力します（ローカル開発時想定）');
    fs.mkdirSync('public/articles', { recursive: true });
    fs.writeFileSync('public/articles.json', JSON.stringify({ articles: [], generatedAt: new Date().toISOString() }));
    return;
  }

  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: '記事管理!A2:M',
  });
  const rows = sheetRes.data.values || [];
  console.log(`📋 ${rows.length} 行を取得`);

  fs.mkdirSync('public/articles', { recursive: true });

  const summaries = [];
  let okCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue;

    const id = `row-${i + 2}`;
    const level = row[3] || '';
    const docId = row[8] || '';

    process.stdout.write(`  [${i + 1}/${rows.length}] ${row[0].slice(0, 30)}... `);
    const content = await getDocContent(docId);
    console.log(content ? `✓ (${content.length}文字)` : '✗');

    const meta = {
      id,
      title: row[0] || '',
      author: row[1] || '',
      category: row[2] || '',
      level,
      levelLabel: getLevelLabel(level),
      excerpt: row[5] || '',
      thumb: row[6] || '',
      thumbImage: row[7] || '',
      date: row[4] || '',
      views: Number(row[9]) || 0,
      ratings: JSON.parse(row[10] || '[]'),
    };

    fs.writeFileSync(`public/articles/${id}.json`,
      JSON.stringify({ article: { ...meta, content } }));

    summaries.push(meta);
    okCount++;
  }

  summaries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  fs.writeFileSync('public/articles.json',
    JSON.stringify({ articles: summaries, generatedAt: new Date().toISOString() }));

  console.log(`✅ 完了：${okCount}件の記事を public/ に出力しました`);
})().catch(e => {
  console.error('❌ ビルドエラー:', e);
  process.exit(1);
});
