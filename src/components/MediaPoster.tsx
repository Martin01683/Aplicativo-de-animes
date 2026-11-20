import { useState } from 'react';
import { Film } from 'lucide-react';

interface MediaPosterProps {
  src?: string;
  alt: string;
  aspect?: 'portrait' | 'landscape';
  className?: string;
}

export function MediaPoster({
  src,
  alt,
  aspect = 'portrait',
  className = '',
}: MediaPosterProps) {
  const [failed, setFailed] = useState(false);

  const ratioClass = aspect === 'landscape' ? 'aspect-video' : 'aspect-[2/3]';

  return (
    <div
      className={`relative overflow-hidden bg-[#1b2029] ${ratioClass} ${className}`}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
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
