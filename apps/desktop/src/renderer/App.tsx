import { RouterProvider } from "react-router-dom";
import { AuthGate } from "./components/auth/AuthGate";
import { router } from "./router";

export function App() {
  return (
    <AuthGate>
      <RouterProvider router={router} />
    </AuthGate>
  );
}
