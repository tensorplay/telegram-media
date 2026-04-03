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
    .from("creators")
    .select("*")
    .order("name");

  const { data: counts } = await supabase
    .from("media")
    .select("creator_id");

  const countMap = new Map<string, number>();
  counts?.forEach((row) => {
    countMap.set(row.creator_id, (countMap.get(row.creator_id) ?? 0) + 1);
  });

  return (
    <>
      <Navbar email={user?.email} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-semibold mb-6">Creators</h1>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {creators?.map((creator) => {
            const count = countMap.get(creator.id) ?? 0;
            return (
              <Link key={creator.id} href={`/creators/${creator.slug}`}>
                <Card className="transition-shadow hover:shadow-md cursor-pointer">
                  <CardContent className="flex items-center gap-4 p-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                      <FolderOpen className="h-6 w-6 text-neutral-500" />
                    </div>
                    <div>
                      <p className="font-medium text-lg">{creator.name}</p>
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
