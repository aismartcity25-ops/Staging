import { useEffect, useRef, useState } from 'react';

// Incapsula la logica di resize della finestra chat tramite gli 8 handle
// (n/s/e/w/ne/nw/se/sw) — stesso comportamento del widget originale,
// isolata in un hook riutilizzabile.
export function useResizableWindow(initial = { width: 460, height: 640 }) {
  const [dimensions, setDimensions] = useState(initial);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDirection, setResizeDirection] = useState('');
  const windowRef = useRef(null);

  const startResize = (e, direction) => {
    e.preventDefault();
    setIsResizing(true);
    setResizeDirection(direction);
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing || !windowRef.current) return;
      const rect = windowRef.current.getBoundingClientRect();
      let newWidth = dimensions.width;
      let newHeight = dimensions.height;

      if (resizeDirection.includes('e')) {
        newWidth = Math.max(320, Math.min(720, e.clientX - rect.left + 10));
      }
      if (resizeDirection.includes('s')) {
        newHeight = Math.max(420, Math.min(820, e.clientY - rect.top + 10));
      }
      if (resizeDirection.includes('w')) {
        newWidth = Math.max(320, Math.min(720, rect.right - e.clientX + 10));
      }
      if (resizeDirection.includes('n')) {
        newHeight = Math.max(420, Math.min(820, rect.bottom - e.clientY + 10));
      }

      setDimensions({ width: newWidth, height: newHeight });
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setResizeDirection('');
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor =
        resizeDirection.includes('e') || resizeDirection.includes('w')
          ? 'ew-resize'
          : resizeDirection.includes('n') || resizeDirection.includes('s')
          ? 'ns-resize'
          : 'nwse-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, resizeDirection, dimensions]);

  return { dimensions, windowRef, startResize };
}
