import { Package } from "lucide-react";
import { DeleteIngredientButton } from "@/components/delete-ingredient-button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatExpiryLabel, getExpiryStatus } from "@/lib/expiry";
import { getIngredientEmoji } from "@/lib/ingredient-emoji";
import { formatQuantity } from "@/lib/shopping-utils";
import { getExpiryClasses } from "@/lib/pantry-utils";
import { cn } from "@/lib/cn";
import type { PantryItem } from "@/types/pantry";

type PantryListProps = {
  items: PantryItem[];
};

function expiryBadgeClass(status: ReturnType<typeof getExpiryStatus>) {
  switch (status) {
    case "expired":
      return "text-red-700 dark:text-red-400";
    case "today":
      return "text-amber-700 dark:text-amber-400";
    case "tomorrow":
      return "text-yellow-700 dark:text-yellow-400";
    case "soon":
      return "text-orange-700 dark:text-orange-400";
    default:
      return "text-muted";
  }
}

export function PantryList({ items }: PantryListProps) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Package className="h-10 w-10" aria-hidden="true" />}
        title="Your pantry is empty."
        description="Add ingredients manually or scan your first shopping receipt."
        primaryAction={{ label: "Add Ingredient", href: "#add-ingredient" }}
        secondaryAction={{ label: "Scan Receipt", href: "/receipt-scanner" }}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      {items.map((item) => {
        const expiryStatus = getExpiryStatus(item.expiry_date);
        const quantityLabel = formatQuantity(item.quantity, item.unit);

        return (
          <li key={item.id}>
            <Card
              className={cn(
                "flex items-center gap-5 border p-6",
                getExpiryClasses(expiryStatus)
              )}
            >
              <span
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-3xl dark:bg-zinc-800"
                role="img"
                aria-hidden="true"
              >
                {getIngredientEmoji(item.ingredient_name)}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-foreground">
                  {item.ingredient_name}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  {quantityLabel && (
                    <span className="text-muted">
                      {quantityLabel}
                    </span>
                  )}
                  <span className={expiryBadgeClass(expiryStatus)}>
                    {formatExpiryLabel(item.expiry_date)}
                  </span>
                </div>
              </div>

              <DeleteIngredientButton
                id={item.id}
                label={item.ingredient_name}
                variant="labelled"
              />
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
