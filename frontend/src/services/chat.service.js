import { apiClient } from '../api/client.js';

export const createChatService = ({ getToken, onUnauthorized } = {}) => {
  const client = apiClient(getToken, { onUnauthorized });

  const getChats = async ({ status, cursor, limit, search } = {}) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (cursor) qs.set('cursor', cursor);
    if (limit) qs.set('limit', limit);
    if (search) qs.set('search', search);
    const url = qs.toString() ? `/chats?${qs.toString()}` : '/chats';
    return client.request(url, { method: 'GET' });
  };

  const getChatSummary = async () => client.request('/chat/summary', { method: 'GET' });

  const getMessages = async (chatId, { limit, cursor } = {}) => {
    const qs = new URLSearchParams();
    if (limit) qs.set('limit', limit);
    if (cursor) qs.set('cursor', cursor);
    const query = qs.toString();
    const path = query ? `/chats/${chatId}/messages?${query}` : `/chats/${chatId}/messages`;
    const data = await client.request(path, { method: 'GET' });
    // backend devuelve { messages, nextCursor }
    if (data?.messages) return data;
    return { messages: Array.isArray(data) ? data : [], nextCursor: null };
  };

  const assignChat = async (chatId) => client.request(`/chats/${chatId}/assign`, { method: 'POST' });

  const closeChat = async (chatId) => client.request(`/chats/${chatId}/close`, { method: 'POST' });

  const reopenChat = async (chatId) => client.request(`/chats/${chatId}/reopen`, { method: 'POST' });

  const sendMessage = async (chatId, content) =>
    client.request(`/messages/send`, { method: 'POST', body: { chatId, content } });

  const sendMedia = async (chatId, file, caption = '', { onProgress } = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (caption) form.append('caption', caption);

    // XHR para poder exponer progreso de subida.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', client.buildUrl(`/chat/${chatId}/messages/media`));
      xhr.responseType = 'json';
      xhr.setRequestHeader('X-Requested-With', 'whatssuite-frontend');
      const token = typeof getToken === 'function' ? getToken() : null;
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        const percent = Math.round((evt.loaded / evt.total) * 100);
        onProgress?.(percent);
      };

      xhr.onload = async () => {
        const status = xhr.status;
        const payload = xhr.response;
        if (status === 401) {
          if (onUnauthorized) await onUnauthorized({ status });
        }
        if (status >= 200 && status < 300) {
          resolve(payload?.data || payload);
        } else {
          const message = payload?.error || payload?.message || 'Upload failed';
          reject(new Error(message));
        }
      };

      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.send(form);
    });
  };

  const reassignChat = async (chatId, payload) =>
    client.request(`/chats/${chatId}/reassign`, { method: 'POST', body: payload });

  const deleteMessage = async (messageId) =>
    client.request(`/messages/${messageId}/delete`, { method: 'POST' });

  const createChat = async ({ sessionName, contact, queueId }) =>
    client.request(`/chats`, { method: 'POST', body: { sessionName, contact, queueId } });

  const listConnections = async () => client.request('/chats/connections', { method: 'GET' });

  const findChatsByPhoneForExport = async ({ phone, limit } = {}) => {
    const qs = new URLSearchParams();
    if (phone) qs.set('phone', phone);
    if (limit) qs.set('limit', limit);
    const query = qs.toString();
    return client.request(`/chats/export/by-phone${query ? `?${query}` : ''}`, { method: 'GET' });
  };

  return {
    getChats,
    getChatSummary,
    getMessages,
    assignChat,
    closeChat,
    reopenChat,
    sendMessage,
    sendMedia,
    reassignChat,
    deleteMessage,
    createChat,
    listConnections,
    findChatsByPhoneForExport
  };
};

export default createChatService;
