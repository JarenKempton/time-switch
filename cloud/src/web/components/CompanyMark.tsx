import type { CSSProperties } from "react";
import { cn } from "@/web/lib/utils";
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
  return (
    <span
      className={cn(
        "company-mark",
        `company-mark--${size}`,
        company.logoUrl ? "company-mark--logo" : "company-mark--dot",
        className,
      )}
      style={companyStyle(company)}
      aria-hidden="true"
    >
      {company.logoUrl ? <img src={company.logoUrl} alt="" /> : null}
    </span>
  );
}
