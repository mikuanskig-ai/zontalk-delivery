'use client';

// Ler o QR code da mesa com a câmera de dentro do app. Necessário
// porque, no iPhone, o app instalado na tela inicial não compartilha os
// cookies do Safari: um QR lido pela câmera nativa abriria no Safari,
// sem a conexão do aparelho. Aqui a leitura acontece já logado.

import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import jsQR from 'jsqr';
import { toast } from 'sonner';
import { ApiError, api } from './api';
import { useSalao } from './salao-context';

/** O QR impresso traz https://<site>/m/<32 hex>; aceita também só o código. */
export function extractTableToken(text: string): string | null {
  const match = /(?:\/m\/)?([0-9a-f]{32})(?:[/?#].*)?$/i.exec(text.trim());
  return match ? match[1].toLowerCase() : null;
}

export function ScanView() {
  const { go } = useSalao();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'starting' | 'scanning' | 'opening' | 'denied'>('starting');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setStatus('scanning');
        tick();
      } catch {
        setStatus('denied');
      }
    }

    async function onToken(token: string) {
      setStatus('opening');
      try {
        const res = await api<{ tab_id: string; table_number: number }>('/scan', { body: { token } });
        stopped = true;
        toast.success(`Mesa ${res.table_number}`);
        go({ name: 'tab', id: res.tab_id });
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Não foi possível abrir a mesa.');
        // volta a procurar depois de um respiro, sem ler o mesmo QR em loop
        window.setTimeout(() => {
          if (!stopped) {
            setStatus('scanning');
            raf = requestAnimationFrame(tick);
          }
        }, 1500);
      }
    }

    function tick() {
      if (stopped) return;
      const video = videoRef.current;
      if (video && ctx && video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        // Reduz para ~640px de largura: leitura mais rápida sem perder o QR.
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        const token = code ? extractTableToken(code.data) : null;
        if (token) {
          void onToken(token);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    }

    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [go]);

  return (
    <div className="space-y-4 px-4 py-4">
      <h1 className="text-lg font-semibold text-foreground">Escanear mesa</h1>
      {status === 'denied' ? (
        <div className="space-y-2 rounded-xl border border-border bg-card p-5 text-sm text-foreground">
          <Camera className="size-6 text-muted-foreground" />
          <p className="font-medium">Não foi possível usar a câmera.</p>
          <p className="text-muted-foreground">Libere o acesso à câmera nas configurações do navegador para este site e volte a esta tela. Você também pode abrir a mesa tocando nela no mapa.</p>
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-2xl border border-border bg-black">
          <video ref={videoRef} playsInline muted className="aspect-square w-full object-cover" />
          <div className="pointer-events-none absolute inset-8 rounded-2xl border-2 border-white/80" />
          {status !== 'scanning' ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
              <Loader2 className="size-6 animate-spin" />
            </div>
          ) : null}
        </div>
      )}
      <p className="text-center text-sm text-muted-foreground">Aponte a câmera para o QR code da mesa.</p>
    </div>
  );
}
