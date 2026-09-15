/** The row header shape ItemListEditor.vue renders (a .vue file cannot export types). */
export interface EditorRow {
  id: string;
  title: string;
  detail?: string;
  chip?: { label: string; tone: "safe" | "warning" | "danger" | "neutral" };
}
