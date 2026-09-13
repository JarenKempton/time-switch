import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { Company } from "../api";

export const DEFAULT_COMPANY_COLOR = "#62e6a7";

export function companyColor(company: Pick<Company, "color">): string {
  return company.color ?? DEFAULT_COMPANY_COLOR;
}

export function companyStyle(company: Pick<Company, "color">): CSSProperties {
  return { "--company-color": companyColor(company) } as CSSProperties;
}

export function CompanyMark({
  company,
  size = "md",
  className,
}: {
  company: Pick<Company, "name" | "color" | "logoUrl">;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const initials = company.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className={cn("company-mark", `company-mark--${size}`, className)}
      style={companyStyle(company)}
      aria-hidden="true"
    >
      {company.logoUrl ? <img src={company.logoUrl} alt="" /> : initials}
    </span>
  );
}
