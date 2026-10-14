import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { captureError, initAnalytics } from './analytics';
import Maker from './maker/Maker';

initAnalytics();

const onError = (error: unknown, info: { componentStack?: string }) => captureError(error, info.componentStack);

createRoot(document.getElementById('root')!, { onCaughtError: onError, onUncaughtError: onError }).render(
  <StrictMode>
    <Maker />
  </StrictMode>,
);
