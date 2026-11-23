import Link from "next/link";
import { logoutAction } from "../login/actions";

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <header className="topbar">
        <nav aria-label="main">
          <Link href="/endpoints" prefetch={false}>
            endpoints
          </Link>
          <Link href="/" prefetch={false}>
            health
          </Link>
        </nav>
        <form action={logoutAction}>
          <button type="submit" className="secondary">
            sign out
          </button>
        </form>
      </header>
      {children}
    </>
  );
}
