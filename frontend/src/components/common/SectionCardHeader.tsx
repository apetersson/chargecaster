import type { JSX, ReactNode } from "react";

type SectionCardHeaderProps = {
  title: string;
  subtitle?: string | null;
  actions?: ReactNode;
};

function SectionCardHeader({title, subtitle, actions}: SectionCardHeaderProps): JSX.Element {
  return (
    <div className="section-card-header">
      <div className="section-card-heading">
        <h2>{title}</h2>
        {subtitle ? <p className="section-card-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="section-card-actions">{actions}</div> : null}
    </div>
  );
}

export default SectionCardHeader;
