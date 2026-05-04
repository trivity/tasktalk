import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Login } from './routes/login.js';
import { Settings } from './routes/settings.js';
import { Members } from './routes/members.js';
import { Chat } from './routes/chat.js';
import { Onboarding } from './routes/onboarding.js';
import { Routines } from './routes/routines.js';
import { useTheme } from './hooks/use-theme.js';

export function App() {
  // Initialize theme on app mount
  useTheme();
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/login/callback" element={<Login />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/members" element={<Members />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/chat/:id" element={<Chat />} />
        <Route path="/routines" element={<Routines />} />
        <Route path="/" element={<Navigate to="/chat" replace />} />
      </Routes>
      <Toaster position="top-right" richColors closeButton />
    </>
  );
}
