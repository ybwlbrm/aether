export interface ConvertOption {
  from: string[];
  to: string[];
  label: string;
  desc: string;
  icon: React.ReactNode;
  color: string;
  hint: string;
  kind?: 'convert' | 'pdf-operate' | 'pdf-read' | 'pdf-compress' | 'pdf-to-docx' | 'unlock' | 'utility' | 'encode';
  op?: string; // pdf-operate: merge/watermark; pdf-read: to-image/to-text
}

export interface ToolCategory {
  id: string;
  label: string;
  color: string;
}