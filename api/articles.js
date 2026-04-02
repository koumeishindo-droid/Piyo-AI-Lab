// ============================================
// Vercel サーバーレス関数: /api/articles
// Notion の「記事管理」データベースからデータを取得し、
// メインWEB（index.html）に渡す中継役です。
//
// 【改修】本文をページ本文（ブロック）から取得し、
// HTMLに自動変換するように変更しました。
// これにより、Notionのページに普通に書くだけで
// 画像付きの記事がWEBに反映されます。
// ============================================

const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const ARTICLES_DB_ID = process.env.NOTION_ARTICLES_DB_ID;

module.exports = async (req, res) => {
  // どのドメインからでもデータを取得できるようにする設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Notion データベースから記事一覧を取得
    const response = await notion.databases.query({
      database_id: ARTICLES_DB_ID,
      sorts: [{ property: '日付', direction: 'descending' }],
    });

    // 各記事のページ本文（ブロック）を並行して取得
    const articles = await Promise.all(
      response.results.map(async (page) => {
        const props = page.properties;

        // ページ本文のブロックを取得してHTMLに変換
        const content = await getPageContent(page.id);

        return {
          id: page.id,
          title: getTitle(props['タイトル']),
          author: getRichText(props['執筆者']),
          category: getMultiSelect(props['カテゴリ']),
          level: getMultiSelect(props['レベル']),
          levelLabel: getLevelLabel(getMultiSelect(props['レベル'])),
          excerpt: getRichText(props['概要']),
          content: content,
          thumb: getRichText(props['サムネイル背景']),
          thumbImage: getUrl(props['サムネイル画像']),
          date: getDate(props['日付']),
          views: getNumber(props['閲覧数']),
          ratings: JSON.parse(getRichText(props['評価データ']) || '[]'),
        };
      })
    );

    res.status(200).json({ articles });
  } catch (error) {
    console.error('Notion API エラー:', error);
    res.status(500).json({ error: 'データの取得に失敗しました' });
  }
};

// ============================================
// ページ本文（ブロック）を取得してHTMLに変換
// ============================================

async function getPageContent(pageId) {
  try {
    const blocks = [];
    let cursor = undefined;

    // ブロックを全件取得（ページネーション対応）
    do {
      const response = await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });
      blocks.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    // ブロックをHTMLに変換
    return blocksToHtml(blocks);
  } catch (error) {
    console.error('ブロック取得エラー:', error);
    return '';
  }
}

// ============================================
// Notion ブロックをHTMLに変換する関数
// ============================================

function blocksToHtml(blocks) {
  let html = '';
  let inList = false;
  let listType = '';

  for (const block of blocks) {
    // リストの開始・終了を管理
    const isList =
      block.type === 'bulleted_list_item' ||
      block.type === 'numbered_list_item';
    const currentListType =
      block.type === 'bulleted_list_item'
        ? 'ul'
        : block.type === 'numbered_list_item'
          ? 'ol'
          : '';

    if (inList && (!isList || currentListType !== listType)) {
      html += `</${listType}>`;
      inList = false;
    }

    if (isList && !inList) {
      listType = currentListType;
      html += `<${listType}>`;
      inList = true;
    }

    html += blockToHtml(block);
  }

  // 最後のリストを閉じる
  if (inList) {
    html += `</${listType}>`;
  }

  return html;
}

function blockToHtml(block) {
  switch (block.type) {
    case 'paragraph':
      const pText = richTextToHtml(block.paragraph.rich_text);
      if (!pText) return '<br>';
      return `<p>${pText}</p>`;

    case 'heading_1':
      return `<h1>${richTextToHtml(block.heading_1.rich_text)}</h1>`;

    case 'heading_2':
      return `<h2>${richTextToHtml(block.heading_2.rich_text)}</h2>`;

    case 'heading_3':
      return `<h3>${richTextToHtml(block.heading_3.rich_text)}</h3>`;

    case 'bulleted_list_item':
      return `<li>${richTextToHtml(block.bulleted_list_item.rich_text)}</li>`;

    case 'numbered_list_item':
      return `<li>${richTextToHtml(block.numbered_list_item.rich_text)}</li>`;

    case 'to_do':
      const checked = block.to_do.checked ? 'checked' : '';
      return `<p><input type="checkbox" ${checked} disabled> ${richTextToHtml(block.to_do.rich_text)}</p>`;

    case 'toggle':
      return `<details><summary>${richTextToHtml(block.toggle.rich_text)}</summary></details>`;

    case 'quote':
      return `<blockquote>${richTextToHtml(block.quote.rich_text)}</blockquote>`;

    case 'callout':
      const icon = block.callout.icon?.emoji || '';
      return `<div class="callout"><span>${icon}</span> ${richTextToHtml(block.callout.rich_text)}</div>`;

    case 'code':
      return `<pre><code>${richTextToHtml(block.code.rich_text)}</code></pre>`;

    case 'divider':
      return '<hr>';

    case 'image':
      return imageBlockToHtml(block);

    case 'video':
      return videoBlockToHtml(block);

    case 'bookmark':
      const url = block.bookmark.url || '';
      return `<p><a href="${url}" target="_blank">${url}</a></p>`;

    case 'embed':
      const embedUrl = block.embed.url || '';
      return `<iframe src="${embedUrl}" width="100%" height="400" frameborder="0" allowfullscreen></iframe>`;

    case 'table':
      // テーブルは子ブロックの取得が必要なため、簡易対応
      return '<p>[テーブル]</p>';

    default:
      return '';
  }
}

// ============================================
// 画像ブロックをHTMLに変換
// Notionの画像URL（アップロード画像は一時URL）を
// そのまま使用します。
// ============================================

function imageBlockToHtml(block) {
  let url = '';
  const caption = block.image.caption
    ? richTextToHtml(block.image.caption)
    : '';

  if (block.image.type === 'file') {
    // Notionにアップロードされた画像（一時URL、約1時間有効）
    url = block.image.file.url;
  } else if (block.image.type === 'external') {
    // 外部URLの画像
    url = block.image.external.url;
  }

  if (!url) return '';

  let html = `<img src="${url}" alt="${caption || '記事の画像'}" style="max-width:100%; height:auto;">`;
  if (caption) {
    html = `<figure>${html}<figcaption>${caption}</figcaption></figure>`;
  }
  return html;
}

// ============================================
// 動画ブロックをHTMLに変換
// ============================================

function videoBlockToHtml(block) {
  let url = '';

  if (block.video.type === 'file') {
    url = block.video.file.url;
  } else if (block.video.type === 'external') {
    url = block.video.external.url;
  }

  if (!url) return '';

  // YouTube の場合は埋め込みに変換
  const youtubeMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/
  );
  if (youtubeMatch) {
    return `<iframe width="100%" height="400" src="https://www.youtube.com/embed/${youtubeMatch[1]}" frameborder="0" allowfullscreen></iframe>`;
  }

  return `<video src="${url}" controls style="max-width:100%;"></video>`;
}

// ============================================
// リッチテキスト（装飾付きテキスト）をHTMLに変換
// 太字・斜体・下線・取り消し線・リンク・コードに対応
// ============================================

function richTextToHtml(richTextArray) {
  if (!richTextArray || !richTextArray.length) return '';

  return richTextArray
    .map((rt) => {
      let text = escapeHtml(rt.plain_text);

      // 改行をHTMLの改行に変換
      text = text.replace(/\n/g, '<br>');

      // 装飾を適用
      if (rt.annotations) {
        if (rt.annotations.bold) text = `<strong>${text}</strong>`;
        if (rt.annotations.italic) text = `<em>${text}</em>`;
        if (rt.annotations.underline) text = `<u>${text}</u>`;
        if (rt.annotations.strikethrough) text = `<s>${text}</s>`;
        if (rt.annotations.code)
          text = `<code>${text}</code>`;
        if (rt.annotations.color && rt.annotations.color !== 'default') {
          text = `<span style="color:${rt.annotations.color}">${text}</span>`;
        }
      }

      // リンク
      if (rt.href) {
        text = `<a href="${rt.href}" target="_blank">${text}</a>`;
      }

      return text;
    })
    .join('');
}

// ============================================
// HTMLエスケープ（セキュリティ対策）
// ============================================

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Notion プロパティから値を取り出すための便利関数 =====

function getTitle(prop) {
  if (!prop || !prop.title || !prop.title.length) return '';
  return prop.title.map((t) => t.plain_text).join('');
}

function getRichText(prop) {
  if (!prop || !prop.rich_text || !prop.rich_text.length) return '';
  return prop.rich_text.map((t) => t.plain_text).join('');
}

function getSelect(prop) {
  if (!prop || !prop.select) return '';
  return prop.select.name || '';
}

function getMultiSelect(prop) {
  if (!prop || !prop.multi_select || !prop.multi_select.length) return '';
  return prop.multi_select[0].name || '';
}

function getDate(prop) {
  if (!prop || !prop.date || !prop.date.start) return '';
  return prop.date.start;
}

function getNumber(prop) {
  if (!prop || prop.number === null || prop.number === undefined) return 0;
  return prop.number;
}

function getUrl(prop) {
  if (!prop || !prop.url) return '';
  return prop.url;
}

function getLevelLabel(level) {
  const labels = {
    beginner: 'ひよこ',
    intermediate: '育ちざかり',
    advanced: 'にわとり',
  };
  return labels[level] || level;
}
