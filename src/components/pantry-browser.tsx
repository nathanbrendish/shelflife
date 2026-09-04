"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  List,
  MapPin,
  Pencil,
} from "lucide-react";
import {
  classifyPantryFood,
  updatePantryItem,
} from "@/app/actions/pantry";
import { DeleteIngredientButton } from "@/components/delete-ingredient-button";
import { PantryEditModal } from "@/components/pantry-edit-modal";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ExpiryBadge } from "@/components/ui/badge";
import { SearchBar } from "@/components/ui/search-bar";
import { formatExpiryLabel, getExpiryStatus } from "@/lib/expiry";
import { UNCLASSIFIED_LABEL } from "@/lib/food-classification";
import { getIngredientEmoji } from "@/lib/ingredient-emoji";
import { getExpiryClasses } from "@/lib/pantry-utils";
import { formatQuantity } from "@/lib/shopping-utils";
import { cn } from "@/lib/cn";
import type { PantryItem } from "@/types/pantry";
import type {
  FoodCategory,
  FoodSubcategory,
  StorageLocation,
} from "@/types/taxonomy";

type PantryBrowserProps = {
  items: PantryItem[];
  storageLocations: StorageLocation[];
  categories: FoodCategory[];
  subcategories: FoodSubcategory[];
};

type ViewMode = "comfortable" | "compact";

const EXPIRING_STATUSES = new Set(["expired", "today", "tomorrow", "soon"]);
const UNASSIGNED_KEY = "unassigned";

export function PantryBrowser({
  items,
  storageLocations,
  categories,
  subcategories,
}: PantryBrowserProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("comfortable");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editingItem, setEditingItem] = useState<PantryItem | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        event.preventDefault();
        document.getElementById("pantry-search")?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      item.ingredient_name.toLowerCase().includes(q)
    );
  }, [items, search]);

  const expiringSoon = useMemo(
    () =>
      filtered.filter((item) =>
        EXPIRING_STATUSES.has(getExpiryStatus(item.expiry_date))
      ),
    [filtered]
  );

  const byStorage = useMemo(() => {
    const groups = storageLocations.map((location) => ({
      key: location.id,
      title: location.name,
      icon: location.icon ?? "📦",
      items: filtered.filter((item) => item.storage_location_id === location.id),
    }));

    const unassigned = filtered.filter((item) => !item.storage_location_id);

    const result = groups.filter((group) => group.items.length > 0);

    if (unassigned.length > 0) {
      result.push({
        key: UNASSIGNED_KEY,
        title: "Unassigned",
        icon: "📍",
        items: unassigned,
      });
    }

    return result;
  }, [filtered, storageLocations]);

  const handleSave = async (
    id: string,
    data: {
      ingredient_name: string;
      quantity: number;
      unit: string | null;
      expiry_date: string | null;
      storage_location_id: string | null;
    }
  ) => {
    const result = await updatePantryItem(id, data);
    if (result.success) {
      router.refresh();
      return { success: true };
    }
    return { success: false, error: result.error };
  };

  const handleReclassify = async (
    id: string,
    foodCategoryId: string,
    foodSubcategoryId: string | null
  ) => {
    const result = await classifyPantryFood(id, foodCategoryId, foodSubcategoryId);
    if (result.success) {
      router.refresh();
      return { success: true };
    }
    return { success: false, error: result.error };
  };

  // Comfortable: spacious card with full metadata (emoji, quantity, category +
  // subcategory classification, expiry). Optimised for browsing.
  const renderComfortableItem = (item: PantryItem) => {
    const status = getExpiryStatus(item.expiry_date);
    const qty = formatQuantity(item.quantity, item.unit);
    const categoryName = item.cached_category?.name ?? UNCLASSIFIED_LABEL;
    const categoryIcon = item.cached_category?.icon ?? "🏷️";
    const subcategoryName = item.cached_subcategory?.name ?? null;
    const isUnclassified = !item.cached_category_id;

    return (
      <li key={item.id} className="pp-slide-up">
        <Card
          className={cn(
            "flex items-center gap-5 border p-5",
            getExpiryClasses(status)
          )}
        >
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-background text-3xl"
            aria-hidden="true"
          >
            {getIngredientEmoji(item.ingredient_name)}
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground">
              {item.ingredient_name}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
              {qty && (
                <span className="font-medium text-foreground">{qty}</span>
              )}
              <span
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium",
                  isUnclassified
                    ? "bg-slate-100 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400"
                    : "bg-background text-muted"
                )}
              >
                {categoryIcon} {categoryName}
                {subcategoryName ? ` · ${subcategoryName}` : ""}
              </span>
              <ExpiryBadge
                label={formatExpiryLabel(item.expiry_date)}
                status={status}
              />
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditingItem(item)}
              className="min-w-11 px-3"
              aria-label={`Edit ${item.ingredient_name}`}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <DeleteIngredientButton
              id={item.id}
              label={item.ingredient_name}
              variant="icon"
              className="shrink-0"
            />
          </div>
        </Card>
      </li>
    );
  };

  // Compact: dense single-line row inside a shared list container. Optimised for
  // scanning a large pantry with minimal scrolling.
  const renderCompactItem = (item: PantryItem) => {
    const status = getExpiryStatus(item.expiry_date);
    const qty = formatQuantity(item.quantity, item.unit);

    return (
      <li
        key={item.id}
        className="flex items-center gap-3 px-3 py-2 hover:bg-background/60"
      >
        <span className="text-base" aria-hidden="true">
          {getIngredientEmoji(item.ingredient_name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {item.ingredient_name}
        </span>
        {qty && (
          <span className="shrink-0 text-xs text-muted">{qty}</span>
        )}
        <span className="hidden shrink-0 sm:inline">
          <ExpiryBadge
            label={formatExpiryLabel(item.expiry_date)}
            status={status}
          />
        </span>
        <button
          type="button"
          onClick={() => setEditingItem(item)}
          className="pp-focus-ring shrink-0 rounded-lg p-1.5 text-muted hover:bg-background hover:text-foreground"
          aria-label={`Edit ${item.ingredient_name}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <DeleteIngredientButton
          id={item.id}
          label={item.ingredient_name}
          variant="compact"
        />
      </li>
    );
  };

  const renderSection = (
    title: string,
    sectionItems: PantryItem[],
    key: string,
    icon?: string
  ) => {
    const isCollapsed = collapsed[key] ?? false;
    const isCompact = viewMode === "compact";

    return (
      <section key={key}>
        <button
          type="button"
          onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
          className="sticky top-[72px] z-10 flex w-full items-center gap-2 rounded-lg bg-slate-50/95 py-3 text-left backdrop-blur-sm dark:bg-zinc-950/95"
        >
          {isCollapsed ? (
            <ChevronRight className="h-5 w-5 text-zinc-400" />
          ) : (
            <ChevronDown className="h-5 w-5 text-zinc-400" />
          )}
          <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            {icon && (
              <span className="text-xl" aria-hidden="true">
                {icon}
              </span>
            )}
            {title}
            <span className="ml-2 text-sm font-normal text-muted">
              ({sectionItems.length})
            </span>
          </h3>
        </button>

        <div className="pp-collapse" data-open={!isCollapsed}>
          {isCompact ? (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {sectionItems.map(renderCompactItem)}
            </ul>
          ) : (
            <ul className="flex flex-col gap-3">
              {sectionItems.map(renderComfortableItem)}
            </ul>
          )}
        </div>
      </section>
    );
  };

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<span className="text-4xl">🥫</span>}
        title="Your pantry is empty."
        description="Let's scan your first receipt — or add an ingredient manually."
        primaryAction={{ label: "Scan Receipt", href: "/receipt-scanner" }}
        secondaryAction={{ label: "Add Ingredient", href: "#add-ingredient" }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="sticky top-0 z-20 -mx-1 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur-md dark:border-slate-700 dark:bg-slate-900/95">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchBar
            id="pantry-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch("")}
            placeholder="Search ingredients… (press /)"
            aria-label="Search pantry ingredients"
            className="flex-1"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant={viewMode === "comfortable" ? "primary" : "secondary"}
              onClick={() => setViewMode("comfortable")}
              className="h-12 gap-2"
              aria-label="Comfortable view"
            >
              <LayoutGrid className="h-4 w-4" />
              Comfortable
            </Button>
            <Button
              type="button"
              variant={viewMode === "compact" ? "primary" : "secondary"}
              onClick={() => setViewMode("compact")}
              className="h-12 gap-2"
              aria-label="Compact view"
            >
              <List className="h-4 w-4" />
              Compact
            </Button>
          </div>
        </div>
        <p className="mt-2 flex items-center gap-1 text-xs text-muted">
          <MapPin className="h-3 w-3" />
          {filtered.length} of {items.length} ingredients, grouped by storage
          location
        </p>
      </div>

      {filtered.length === 0 ? (
        <Card className="px-8 py-12 text-center">
          <p className="text-sm text-muted">No ingredients match your search.</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-8">
          {expiringSoon.length > 0 &&
            renderSection("Expiring Soon", expiringSoon, "expiring-soon", "⏰")}
          {byStorage.map(({ key, title, icon, items: sectionItems }) =>
            renderSection(title, sectionItems, key, icon)
          )}
        </div>
      )}

      <PantryEditModal
        item={editingItem}
        storageLocations={storageLocations}
        categories={categories}
        subcategories={subcategories}
        onClose={() => setEditingItem(null)}
        onSave={handleSave}
        onReclassify={handleReclassify}
      />
    </div>
  );
}
