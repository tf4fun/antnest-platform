import {
  cloneElement,
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { mergeIDRefs } from "../../lib/accessibility";
import { cn } from "../../lib/utils";

const control =
  "w-full rounded-md border border-border bg-white px-3 text-sm text-foreground shadow-xs outline-hidden transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(control, "h-10", className)} {...props} />,
);
Input.displayName = "Input";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => <select ref={ref} className={cn(control, "h-10", className)} {...props} />,
);
Select.displayName = "Select";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(control, "min-h-24 py-2", className)} {...props} />,
);
Textarea.displayName = "Textarea";

type CheckboxFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "aria-label" | "aria-labelledby" | "type"
> & {
  containerClassName?: string;
  hint?: string;
  label: string;
};

export const CheckboxField = forwardRef<HTMLInputElement, CheckboxFieldProps>(({
  className,
  containerClassName,
  hint,
  id,
  label,
  "aria-describedby": existingDescription,
  ...props
}, ref) => {
  const generatedID = useId();
  const controlID = id ?? generatedID;
  const labelID = `${controlID}-label`;
  const hintID = hint ? `${controlID}-hint` : undefined;

  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-md border border-border bg-white p-3 text-sm",
        containerClassName,
      )}
      htmlFor={controlID}
    >
      <input
        {...props}
        aria-describedby={mergeIDRefs(existingDescription, hintID)}
        aria-labelledby={labelID}
        className={cn("mt-0.5 h-4 w-4 shrink-0 accent-[#759900]", className)}
        id={controlID}
        ref={ref}
        type="checkbox"
      />
      <span>
        <span className="block font-medium" id={labelID}>{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground" id={hintID}>{hint}</span> : null}
      </span>
    </label>
  );
});
CheckboxField.displayName = "CheckboxField";

type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
};

export function Field({ label, hint, children }: {
  label: string;
  hint?: string;
  children: ReactElement<FieldControlProps>;
}) {
  const generatedID = useId();
  const controlID = children.props.id ?? generatedID;
  const hintID = hint ? `${controlID}-hint` : undefined;
  const describedBy = mergeIDRefs(children.props["aria-describedby"], hintID);

  return (
    <div className="grid gap-1.5 text-sm font-medium text-foreground">
      <label htmlFor={controlID}>{label}</label>
      {cloneElement(children, { id: controlID, "aria-describedby": describedBy })}
      {hint ? <span className="text-xs font-normal text-muted-foreground" id={hintID}>{hint}</span> : null}
    </div>
  );
}
