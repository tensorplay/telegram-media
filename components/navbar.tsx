"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export function Navbar({ email }: { email?: string }) {
  const router = useRouter();
  const supabase = createClient();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b bg-white dark:bg-neutral-900">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/creators" className="text-lg font-semibold tracking-tight">
          Creator Media
        </Link>
        <div className="flex items-center gap-4">
          {email && (
            <span className="text-sm text-muted-foreground hidden sm:inline">
              {email}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
