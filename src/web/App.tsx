import { Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './routes/login.js';
import { Settings } from './routes/settings.js';
import { Members } from './routes/members.js';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/login/callback" element={<Login />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/members" element={<Members />} />
      <Route path="/" element={<Navigate to="/settings" replace />} />
    </Routes>
  );
}
