import { useEffect } from 'react';
import { Outlet, RouterProvider, createHashRouter } from 'react-router-dom';
import { LoginPage } from '@/pages/LoginPage';
import { NotificationContainer } from '@/components/common/NotificationContainer';
import { ConfirmationModal } from '@/components/common/ConfirmationModal';
import { MainLayout } from '@/components/layout/MainLayout';
import { ProtectedRoute } from '@/router/ProtectedRoute';
import { useLanguageStore, usePrivacyStore, useThemeStore } from '@/stores';
import { startPiiMasking } from '@/utils/privacyDom';

function RootShell() {
  return (
    <>
      <NotificationContainer />
      <ConfirmationModal />
      <Outlet />
    </>
  );
}

const router = createHashRouter([
  {
    element: <RootShell />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        path: '/*',
        element: (
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        ),
      },
    ],
  },
]);

function App() {
  const initializeTheme = useThemeStore((state) => state.initializeTheme);
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);

  useEffect(() => {
    const cleanupTheme = initializeTheme();
    return cleanupTheme;
  }, [initializeTheme]);

  useEffect(() => {
    setLanguage(language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 仅用于首屏同步 i18n 语言

  const hidePii = usePrivacyStore((state) => state.hidePii);
  // Sweeps whatever the per-component masks miss (any page, dialog or tooltip).
  useEffect(() => {
    if (!hidePii) return;
    return startPiiMasking();
  }, [hidePii]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <RouterProvider router={router} />;
}

export default App;
