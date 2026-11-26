import { useCallback, useState } from 'react';
import { Film } from 'lucide-react';
import { pickImageWithFallback } from '../lib/episodeAvailability';

interface MediaPosterProps {
  src?: string;
  fallbackSrc?: string;
  alt: string;
  aspect?: 'portrait' | 'landscape';
  className?: string;
  priority?: boolean;
}

export function MediaPoster({
  src,
  fallbackSrc,
  alt,
  aspect = 'portrait',
  className = '',
  priority = false,
}: MediaPosterProps) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const activeSrc = pickImageWithFallback([src, fallbackSrc], failedUrls);
  const loaded = Boolean(activeSrc && loadedSrc === activeSrc);

  const imgRefCallback = useCallback(
    (node: HTMLImageElement | null) => {
      if (node && activeSrc && node.complete && node.naturalWidth > 0) {
        setLoadedSrc(activeSrc);
      }
    },
    [activeSrc]
  );

  const ratioClass = aspect === 'landscape' ? 'aspect-video' : 'aspect-[2/3]';

  return (
    <div
      className={`relative overflow-hidden bg-[#1b2029] ${ratioClass} ${className}`}
    >
      {activeSrc ? (
        <img
          ref={imgRefCallback}
          src={activeSrc}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : 'auto'}
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedSrc(activeSrc)}
          onError={() =>
            setFailedUrls((prev) => (prev.includes(activeSrc) ? prev : [...prev, activeSrc]))
          }
          className={`h-full w-full object-cover transition-[opacity,transform] duration-200 group-hover:scale-[1.03] ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#1b2029] to-[#11141a] p-4 text-center text-slate-500">
          <Film className="h-7 w-7 text-slate-600" />
          <span className="line-clamp-2 text-xs font-medium text-slate-400">
            {alt}
          </span>
        </div>
      )}
    </div>
  );
}

