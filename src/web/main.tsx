import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './Home';
import { Room } from './Room';
import './styles.css';

function App() {
  const match = window.location.pathname.match(/^\/m\/([A-Za-z0-9_-]+)\/?$/);
  return match ? <Room token={match[1]} /> : <Home />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
