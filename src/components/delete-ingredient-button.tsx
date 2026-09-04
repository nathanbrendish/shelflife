"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import { deleteIngredient } from "@/app/actions/pantry";
import { Button } from "@/components/ui/button";

type DeleteIngredientButtonProps = {
  id: string;
  label: string;
  /**
   * - "labelled": full danger button with icon + "Remove" text.
   * - "icon": icon-only danger-styled button (comfortable pantry browser).
   * - "compact": bare icon button for dense list rows.
   */
  variant?: "labelled" | "icon" | "compact";
  className?: string;
};

/**
 * ADR-009 Task 7 (BUG-11): wraps `deleteIngredient` in `useActionState` so a
 * failed delete surfaces an inline error instead of silently doing nothing.
 * Kept as its own client component (rather than making the parent list a
 * client component) since each row needs an independent action state.
 */
export function DeleteIngredientButton({
  id,
  label,
  variant = "labelled",
  className,
}: DeleteIngredientButtonProps) {
  const [state, formAction, isPending] = useActionState(deleteIngredient, null);

  return (
    <form action={formAction} className={className ?? "shrink-0"}>
      <input type="hidden" name="id" value={id} />
      {variant === "compact" ? (
        <button
          type="submit"
          disabled={isPending}
          className="pp-focus-ring rounded-lg p-1.5 text-muted hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-950/40"
          aria-label={`Remove ${label}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : variant === "icon" ? (
        <Button
          type="submit"
          variant="danger"
          disabled={isPending}
          className="min-w-11 px-3"
          aria-label={`Remove ${label}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="submit"
          variant="danger"
          disabled={isPending}
          className="h-10 px-4"
          aria-label={`Remove ${label}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Remove
        </Button>
      )}

      {state?.error && (
        <p
          role="alert"
          className="mt-1.5 max-w-[10rem] text-xs text-red-600 dark:text-red-400"
        >
          {state.error}
        </p>
      )}
    </form>
  );
}
