import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  PAGE_IMAGE_WAIT_TIMEOUT_MS,
  PAGE_LOADING_SETTLE_MS,
  shouldWaitForImage,
} from '../lib/pageLoadingState';

function isElementHidden(el: HTMLElement): boolean {
  return Boolean(el.closest('.hidden, [hidden]'));
}

/**
 * Tracks whether the initial browser document load or any eager / visible
 * `<img>` inside `containerRef` is still loading. Includes a per-image safety
 * timeout so a stalled third-party artwork CDN can never hang the loading bar.
 */
export function usePageImagesPending(
  containerRef: RefObject<HTMLElement | null>,
  scopeKey: string
): { documentLoading: boolean; pendingVisibleImages: boolean } {
  const [documentLoading, setDocumentLoading] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.readyState !== 'complete' : false
  );
  const [pendingVisibleImages, setPendingVisibleImages] = useState(false);
  const timedOutImagesRef = useRef<WeakSet<HTMLImageElement>>(new WeakSet());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (document.readyState === 'complete') {
      setDocumentLoading(false);
      return;
    }
    const handleLoad = () => setDocumentLoading(false);
    window.addEventListener('load', handleLoad, { once: true });
    return () => window.removeEventListener('load', handleLoad);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') {
      setPendingVisibleImages(false);
      return;
    }

    let rafId: number | null = null;
    let safetyTimer: number | null = null;
    let currentPendingImgs: HTMLImageElement[] = [];

    const clearSafetyTimer = () => {
      if (safetyTimer !== null) {
        window.clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    };

    const scanImages = () => {
      rafId = null;
      const viewportHeight = window.innerHeight || 900;
      const imgs = container.querySelectorAll('img');
      const pending: HTMLImageElement[] = [];

      for (const img of imgs) {
        if (timedOutImagesRef.current.has(img)) continue;
        const srcAttr = img.getAttribute('src') || '';
        const rect = img.getBoundingClientRect();
        const shouldWait = shouldWaitForImage(
          {
            hasSrc: Boolean(srcAttr.trim()),
            complete: img.complete,
            loadingAttr: img.getAttribute('loading') || '',
            hidden: isElementHidden(img),
            rect: {
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
          },
          viewportHeight
        );
        if (shouldWait) {
          pending.push(img);
        }
      }

      currentPendingImgs = pending;
      const hasPending = pending.length > 0;
      setPendingVisibleImages(hasPending);

      if (hasPending) {
        if (safetyTimer === null) {
          safetyTimer = window.setTimeout(() => {
            safetyTimer = null;
            for (const stalledImg of currentPendingImgs) {
              timedOutImagesRef.current.add(stalledImg);
            }
            scanImages();
          }, PAGE_IMAGE_WAIT_TIMEOUT_MS);
        }
      } else {
        clearSafetyTimer();
      }
    };

    const scheduleScan = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(scanImages);
    };

    const onImageEvent = (event: Event) => {
      if (event.target instanceof HTMLImageElement) {
        scheduleScan();
      }
    };

    container.addEventListener('load', onImageEvent, true);
    container.addEventListener('error', onImageEvent, true);

    const observer = new MutationObserver(() => {
      scheduleScan();
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'class'],
    });

    scheduleScan();

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      clearSafetyTimer();
      observer.disconnect();
      container.removeEventListener('load', onImageEvent, true);
      container.removeEventListener('error', onImageEvent, true);
    };
  }, [containerRef, scopeKey]);

  return { documentLoading, pendingVisibleImages };
}

/**
 * Turns on immediately when `isRawLoading` becomes true, and waits a brief
 * settle window (after layout/paint frames flush) before hiding so chained
 * page requests (e.g. details -> synopsis -> episode titles -> artwork) never
 * flicker or dismiss the header loading bar prematurely.
 */
export function useSettledLoadingIndicator(isRawLoading: boolean): boolean {
  const [visible, setVisible] = useState(isRawLoading);

  useEffect(() => {
    if (isRawLoading) {
      setVisible(true);
      return;
    }

    let raf1: number | null = null;
    let raf2: number | null = null;
    let timer: number | null = null;

    raf1 = window.requestAnimationFrame(() => {
      raf1 = null;
      raf2 = window.requestAnimationFrame(() => {
        raf2 = null;
        timer = window.setTimeout(() => {
          timer = null;
          setVisible(false);
        }, PAGE_LOADING_SETTLE_MS);
      });
    });

    return () => {
      if (raf1 !== null) window.cancelAnimationFrame(raf1);
      if (raf2 !== null) window.cancelAnimationFrame(raf2);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isRawLoading]);

  return visible;
}
