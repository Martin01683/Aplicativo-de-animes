import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Download,
  Info,
  Play,
  X,
  XCircle,
} from 'lucide-react';
import type { AppNotificationToast } from '../lib/notifications';

interface NotificationToastStackProps {
  toasts: AppNotificationToast[];
  onDismiss: (id: string) => void;
}

interface ToastItemRowProps {
  toast: AppNotificationToast;
  onDismiss: (id: string) => void;
}

function ToastItemRow({ toast, onDismiss }: ToastItemRowProps) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.durationMs);
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    remainingRef.current = toast.durationMs;
  }, [toast.durationMs, toast.id]);

  useEffect(() => {
    if (paused) return;
    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, Math.max(400, remainingRef.current));

    return () => {
      window.clearTimeout(timer);
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(400, remainingRef.current - elapsed);
    };
  }, [onDismiss, paused, toast.id]);

  const toneBorder =
    toast.kind === 'episode' || toast.kind === 'update'
      ? 'border-[#f97316]/45'
      : toast.kind === 'success'
        ? 'border-emerald-500/35'
        : toast.kind === 'warning'
          ? 'border-amber-500/40'
          : toast.kind === 'error'
            ? 'border-rose-500/45'
            : 'border-white/15';

  const renderLeadingVisual = () => {
    if (toast.poster) {
      return (
        <img
          src={toast.poster}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          className="h-12 w-9 shrink-0 rounded-md border border-white/10 object-cover"
        />
      );
    }

    const iconClass = 'h-4.5 w-4.5 shrink-0';
    switch (toast.kind) {
      case 'episode':
        return (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f97316]/15 text-[#fb923c]">
            <BellRing className={iconClass} />
          </div>
        );
      case 'update':
        return (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f97316]/15 text-[#fb923c]">
            <Download className={iconClass} />
          </div>
        );
      case 'success':
        return (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <CheckCircle2 className={iconClass} />
          </div>
        );
      case 'warning':
        return (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
            <AlertTriangle className={iconClass} />
          </div>
        );
      case 'error':
        return (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-400">
            <XCircle className={iconClass} />
          </div>
        );
      default:
        return (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/8 text-slate-300">
            <Info className={iconClass} />
          </div>
        );
    }
  };

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`pointer-events-auto flex w-full items-center gap-3 rounded-xl border ${toneBorder} bg-[#151921]/95 p-3 text-left shadow-2xl backdrop-blur-md transition-all duration-200`}
    >
      {renderLeadingVisual()}

      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold leading-snug text-white">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-300">
            {toast.description}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {toast.actionLabel && toast.onAction && (
          <button
            type="button"
            onClick={() => {
              const fn = toast.onAction;
              onDismiss(toast.id);
              fn?.();
            }}
            className="inline-flex min-h-[34px] items-center gap-1 whitespace-nowrap rounded-lg bg-[#f97316] px-2.5 py-1 text-[11px] font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c]"
          >
            {toast.kind === 'episode' && <Play className="h-3 w-3 fill-current" />}
            <span>{toast.actionLabel}</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label={`Dispensar aviso: ${toast.title}`}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/8 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function NotificationToastStack({
  toasts,
  onDismiss,
}: NotificationToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Notificações recentes"
      className="pointer-events-none fixed inset-x-3 bottom-[74px] z-[60] flex flex-col gap-2 sm:left-auto sm:right-5 sm:w-[380px] md:bottom-5"
    >
      {toasts.map((toast) => (
        <ToastItemRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
