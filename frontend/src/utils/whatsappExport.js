import JSZip from 'jszip';

export const getExportMessageKey = (message) =>
  String(message?.id || message?.whatsappMessageId || `${message?.timestamp || message?.createdAt || ''}-${message?.direction || ''}`);

const extractTextFromPayload = (payload) => {
  if (!payload) return null;
  if (payload.documentWithCaptionMessage?.message?.documentMessage?.caption) {
    return payload.documentWithCaptionMessage.message.documentMessage.caption;
  }
  if (payload.imageMessage?.caption) return payload.imageMessage.caption;
  if (payload.conversation) return payload.conversation;
  if (payload.extendedTextMessage?.text) return payload.extendedTextMessage.text;
  if (payload.message?.conversation) return payload.message.conversation;
  if (payload.message?.extendedTextMessage?.text) return payload.message.extendedTextMessage.text;
  if (payload.ephemeralMessage?.message?.conversation) return payload.ephemeralMessage.message.conversation;
  if (payload.ephemeralMessage?.message?.extendedTextMessage?.text) return payload.ephemeralMessage.message.extendedTextMessage.text;
  if (payload.viewOnceMessage?.message?.conversation) return payload.viewOnceMessage.message.conversation;
  if (payload.viewOnceMessage?.message?.extendedTextMessage?.text) return payload.viewOnceMessage.message.extendedTextMessage.text;
  if (payload.viewOnceMessageV2?.message?.conversation) return payload.viewOnceMessageV2.message.conversation;
  if (payload.viewOnceMessageV2?.message?.extendedTextMessage?.text) return payload.viewOnceMessageV2.message.extendedTextMessage.text;
  if (payload.listResponseMessage?.title) return payload.listResponseMessage.title;
  if (payload.buttonsResponseMessage?.selectedButtonId) return payload.buttonsResponseMessage.selectedButtonId;
  if (payload.protocolMessage?.type === 'HISTORY_SYNC_NOTIFICATION') return '[historial sincronizado]';
  return null;
};

export const getExportMessageText = (message) => {
  const content = message?.content || {};
  const deleted = Boolean(message?.deletedForRemote || message?.deleted_at || message?.deletedAt || message?.status === 'deleted');
  if (deleted) return 'Mensaje eliminado';
  if (typeof content === 'string') return content;
  if (content.text) return content.text;
  const extracted = extractTextFromPayload(content.payload || content.message);
  if (extracted) return extracted;
  if (content.media?.caption) return content.media.caption;
  if (content.media?.fileName) return content.media.fileName;
  if (content.media?.type) return `[${content.media.type}]`;
  if (Array.isArray(content.files) && content.files.length) {
    return content.files.map((file) => file.name || file.type || 'archivo').join('\n');
  }
  return '[mensaje sin texto]';
};

export const formatExportDate = (value) => {
  if (!value) return 'Sin fecha';
  try {
    return new Date(value).toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    });
  } catch {
    return 'Sin fecha';
  }
};

const formatExportTime = (value) => {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
};

const sanitizeFileName = (value) =>
  String(value || 'conversacion')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'conversacion';

const roundRect = (ctx, x, y, width, height, radius) => {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
};

const wrapText = (ctx, text, maxWidth) => {
  const paragraphs = String(text || '').split(/\n/);
  const lines = [];

  paragraphs.forEach((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      return;
    }

    let line = '';
    words.forEach((word) => {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) {
        line = next;
        return;
      }

      if (line) lines.push(line);
      if (ctx.measureText(word).width <= maxWidth) {
        line = word;
        return;
      }

      let chunk = '';
      Array.from(word).forEach((char) => {
        const nextChunk = `${chunk}${char}`;
        if (ctx.measureText(nextChunk).width <= maxWidth) {
          chunk = nextChunk;
        } else {
          if (chunk) lines.push(chunk);
          chunk = char;
        }
      });
      line = chunk;
    });
    if (line) lines.push(line);
  });

  return lines.length ? lines : [''];
};

const getContactName = (chat) =>
  chat?.contactName ||
  chat?.pushName ||
  chat?.remoteName ||
  chat?.contactDisplayName ||
  chat?.remoteNumber ||
  'Contacto';

const buildRows = (messages) => {
  const rows = [];
  let currentDate = null;
  messages.forEach((message) => {
    const rawDate = message.timestamp || message.createdAt || message.updatedAt;
    const dateKey = rawDate ? new Date(rawDate).toDateString() : 'unknown';
    if (dateKey !== currentDate) {
      currentDate = dateKey;
      rows.push({ type: 'date', label: formatExportDate(rawDate) });
    }
    rows.push({ type: 'message', message });
  });
  return rows;
};

const measureRow = (ctx, row) => {
  if (row.type === 'date') return { ...row, height: 42 };

  const message = row.message;
  const maxBubbleWidth = 580;
  const textMaxWidth = maxBubbleWidth - 34;
  ctx.font = '15px Arial, sans-serif';
  const text = getExportMessageText(message);
  const lines = wrapText(ctx, text, textMaxWidth);
  const media = message?.content?.media;
  const mediaHeight = media ? 42 : 0;
  const height = Math.max(48, 18 + lines.length * 20 + mediaHeight + 26);
  const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), 120);
  const bubbleWidth = Math.min(maxBubbleWidth, Math.max(178, textWidth + 34));
  return { ...row, height: height + 12, lines, bubbleHeight: height, bubbleWidth, media };
};

const chunkRows = (rows) => {
  const measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  const measured = rows.map((row) => measureRow(ctx, row));
  const pages = [];
  const maxContentHeight = 7850;
  let page = [];
  let currentHeight = 0;

  measured.forEach((row) => {
    if (page.length && currentHeight + row.height > maxContentHeight) {
      pages.push(page);
      page = [];
      currentHeight = 0;
    }
    page.push(row);
    currentHeight += row.height;
  });

  if (page.length) pages.push(page);
  return pages;
};

const drawHeader = (ctx, { chat, pageNumber, pageCount }) => {
  const contactName = getContactName(chat);
  ctx.fillStyle = '#075e54';
  ctx.fillRect(0, 0, 900, 94);

  ctx.fillStyle = '#d9fdd3';
  ctx.beginPath();
  ctx.arc(54, 47, 27, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#075e54';
  ctx.font = '700 20px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(contactName.slice(0, 1).toUpperCase(), 54, 48);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 20px Arial, sans-serif';
  ctx.fillText(contactName, 92, 35);

  ctx.font = '13px Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  const details = [
    chat?.remoteNumber ? `+${chat.remoteNumber}` : null,
    chat?.whatsappSessionName,
    chat?.queueName
  ].filter(Boolean);
  ctx.fillText(details.join(' · ') || 'Conversacion exportada', 92, 59);

  ctx.textAlign = 'right';
  ctx.font = '12px Arial, sans-serif';
  ctx.fillText(`Pagina ${pageNumber} de ${pageCount}`, 866, 35);
  ctx.fillText(new Date().toLocaleString('es-MX'), 866, 59);
  ctx.textAlign = 'left';
};

const drawBackground = (ctx, width, height) => {
  ctx.fillStyle = '#efeae2';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(120, 105, 80, 0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 54) {
    for (let y = 112; y < height; y += 54) {
      ctx.beginPath();
      ctx.arc(x + 18, y + 18, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
};

const drawDateSeparator = (ctx, row, y) => {
  ctx.font = '700 12px Arial, sans-serif';
  const textWidth = ctx.measureText(row.label).width;
  const width = textWidth + 30;
  const x = (900 - width) / 2;
  roundRect(ctx, x, y + 8, width, 26, 13);
  ctx.fillStyle = '#e1f3fb';
  ctx.fill();
  ctx.fillStyle = '#54656f';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(row.label, 450, y + 21);
  ctx.textAlign = 'left';
};

const drawMessage = (ctx, row, y) => {
  const message = row.message;
  const mine = message.direction === 'out';
  const x = mine ? 900 - 36 - row.bubbleWidth : 36;
  const bubbleY = y + 6;

  roundRect(ctx, x, bubbleY, row.bubbleWidth, row.bubbleHeight, 12);
  ctx.fillStyle = mine ? '#d9fdd3' : '#ffffff';
  ctx.fill();
  ctx.strokeStyle = mine ? 'rgba(103, 146, 91, 0.22)' : 'rgba(17, 27, 33, 0.1)';
  ctx.stroke();

  ctx.fillStyle = '#111b21';
  ctx.font = '15px Arial, sans-serif';
  ctx.textBaseline = 'top';
  let textY = bubbleY + 14;
  row.lines.forEach((line) => {
    ctx.fillText(line, x + 16, textY);
    textY += 20;
  });

  if (row.media) {
    roundRect(ctx, x + 14, textY + 4, row.bubbleWidth - 28, 34, 8);
    ctx.fillStyle = 'rgba(17, 27, 33, 0.06)';
    ctx.fill();
    ctx.fillStyle = '#54656f';
    ctx.font = '12px Arial, sans-serif';
    const mediaLabel = row.media.fileName || row.media.type || 'archivo adjunto';
    ctx.fillText(`Archivo: ${mediaLabel}`, x + 26, textY + 13);
  }

  ctx.font = '12px Arial, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#667781';
  ctx.textAlign = 'right';
  const time = formatExportTime(message.timestamp || message.createdAt);
  const suffix = mine ? ` ${message.status === 'read' || message.status === 'played' ? '✓✓' : '✓'}` : '';
  ctx.fillText(`${time}${suffix}`, x + row.bubbleWidth - 14, bubbleY + row.bubbleHeight - 11);
  ctx.textAlign = 'left';
};

const canvasToBlob = (canvas) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('No se pudo crear la captura'));
    }, 'image/png');
  });

const renderPageToBlob = async ({ chat, rows, pageNumber, pageCount }) => {
  const width = 900;
  const contentHeight = rows.reduce((sum, row) => sum + row.height, 0);
  const height = Math.max(720, Math.ceil(126 + contentHeight + 34));
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  drawBackground(ctx, width, height);
  drawHeader(ctx, { chat, pageNumber, pageCount });

  let y = 110;
  rows.forEach((row) => {
    if (row.type === 'date') drawDateSeparator(ctx, row, y);
    else drawMessage(ctx, row, y);
    y += row.height;
  });

  return canvasToBlob(canvas);
};

const downloadBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
};

export const exportWhatsAppScreenshotsZip = async ({ conversations, messagesByChat, selectedByChat, phone }) => {
  const zip = new JSZip();
  let fileCount = 0;

  for (const chat of conversations) {
    const selected = selectedByChat?.[chat.id] || {};
    const messages = (messagesByChat?.[chat.id] || [])
      .filter((message) => selected[getExportMessageKey(message)])
      .sort((a, b) => new Date(a.timestamp || a.createdAt || 0) - new Date(b.timestamp || b.createdAt || 0));

    if (!messages.length) continue;

    const rows = buildRows(messages);
    const pages = chunkRows(rows);
    const baseName = sanitizeFileName(`${chat.remoteNumber || phone}-${chat.whatsappSessionName || chat.id}`);

    for (let index = 0; index < pages.length; index += 1) {
      const blob = await renderPageToBlob({
        chat,
        rows: pages[index],
        pageNumber: index + 1,
        pageCount: pages.length
      });
      const suffix = pages.length > 1 ? `-${String(index + 1).padStart(2, '0')}` : '';
      zip.file(`${baseName}${suffix}.png`, blob);
      fileCount += 1;
    }
  }

  if (!fileCount) throw new Error('Selecciona al menos un mensaje para exportar');
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(zipBlob, `${sanitizeFileName(`whatssuite-${phone || 'exportacion'}`)}.zip`);
  return fileCount;
};
