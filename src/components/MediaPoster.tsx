import { useCallback, useState } from 'react';
import { Film } from 'lucide-react';

interface MediaPosterProps {
  src?: string;
  alt: string;
  aspect?: 'portrait' | 'landscape';
  className?: string;
  priority?: boolean;
}

export function MediaPoster({
  src,
  alt,
  aspect = 'portrait',
  className = '',
  priority = false,
}: MediaPosterProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const failed = Boolean(src && failedSrc === src);
  const loaded = Boolean(src && loadedSrc === src);

  const imgRefCallback = useCallback(
    (node: HTMLImageElement | null) => {
      if (node && src && node.complete && node.naturalWidth > 0) {
        setLoadedSrc(src);
      }
    },
    [src]
  );

  const ratioClass = aspect === 'landscape' ? 'aspect-video' : 'aspect-[2/3]';

  return (
    <div
      className={`relative overflow-hidden bg-[#1b2029] ${ratioClass} ${className}`}
    >
      {src && !failed ? (
        <img
          ref={imgRefCallback}
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : 'auto'}
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
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

