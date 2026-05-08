import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Navbar } from "@/components/navbar";
import { Card, CardContent } from "@/components/ui/card";
import { FolderOpen } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CreatorsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: creators } = await supabase
    .from("media_creators")
    .select("*")
    .order("name");

  // PostgREST caps row returns at 1000, so don't fetch rows just to count —
  // run a head/count query per creator in parallel instead.
  const countMap = new Map<string, number>();
  await Promise.all(
    (creators ?? []).map(async (creator) => {
      const { count } = await supabase
        .from("media_files")
        .select("id", { count: "exact", head: true })
        .eq("creator_id", creator.id);
      countMap.set(creator.id, count ?? 0);
    })
  );

  return (
    <>
      <Navbar email={user?.email} />
      <main className="mx-auto w-full max-w-5xl px-3 sm:px-4 py-4 sm:py-8">
        <h1 className="text-xl sm:text-2xl font-semibold mb-4 sm:mb-6">Creators</h1>
        <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {creators?.map((creator) => {
            const count = countMap.get(creator.id) ?? 0;
            return (
              <Link
                key={creator.id}
                href={`/creators/${creator.slug}`}
                className="block"
              >
                <Card className="transition-shadow hover:shadow-md cursor-pointer">
                  <CardContent className="flex items-center gap-4 p-4 sm:p-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 shrink-0">
                      <FolderOpen className="h-6 w-6 text-neutral-500" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-lg truncate">{creator.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {count} {count === 1 ? "file" : "files"}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </main>
    </>
  );
}
