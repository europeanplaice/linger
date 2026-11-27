export async function shareApp(): Promise<'shared' | 'copied'> {
  const data = {
    title: 'Linger',
    text: 'Google Drive で管理するプライベート日記アプリ',
    url: window.location.origin,
  };
  if (navigator.share && navigator.canShare?.(data)) {
    await navigator.share(data);
    return 'shared';
  }
  await navigator.clipboard.writeText(window.location.origin);
  return 'copied';
}

export async function shareEntry(_date: string, content: string, label: string): Promise<'shared' | 'copied'> {
  const data = { title: `Diary – ${label}`, text: content };
  if (navigator.share && navigator.canShare?.(data)) {
    await navigator.share(data);
    return 'shared';
  }
  await navigator.clipboard.writeText(content);
  return 'copied';
}

export function receiveSharedText(): Promise<string | null> | undefined {
  const receipt = /^#linger-share=([0-9a-f-]{36})$/.exec(location.hash)?.[1];
  if (!receipt) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve(null);

  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (text: string | null) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      resolve(text);
    };
    const timeout = window.setTimeout(() => finish(null), 5000);
    channel.port1.onmessage = event => finish(typeof event.data === 'string' ? event.data : null);
    try { worker.postMessage({ type: 'linger-take-share', id: receipt }, [channel.port2]); }
    catch { finish(null); }
  });
}
