import type { AttachmentSlot, BillType, ColorKey, RecurrenceType } from '@nopaper/shared';

export interface Category { id: string; label: string; /** Cor que esta pessoa vê (a dela, se escolheu uma; senão a do espaço). */ color: ColorKey; /** Cor do espaço, quando a pessoa trocou a dela. */ baseColor?: ColorKey; kind: 'payable' | 'receivable' | 'both'; isRestricted: boolean; isSystem: boolean; usage: number }
export interface CardCategory { id: string; label: string; color: ColorKey; ruleKey: string | null; usage: number }
export interface Folder { id: string; name: string; label: string; color: ColorKey; usage: number }
export interface AttachmentSummary { id: string; name: string; mime: string; size: number }
export interface Bill {
  id: string; type: BillType; parentId: string | null; description: string; categoryId: string; folderId: string | null;
  cardId: string | null; statementId: string | null; payrollEntryId?: string | null; amount: string; dueDate: string; status: 'pending' | 'paid'; paidAt: string | null; paidAmount: string | null;
  recurrenceType: RecurrenceType; installmentNumber: number | null; totalInstallments: number | null; isIndefinite: boolean;
  relatedPerson: string | null; notes: string | null; barcode: string | null; pixKey: string | null; paymentMethod: string | null;
  attachments: Partial<Record<AttachmentSlot, AttachmentSummary>>; createdAt: string; updatedAt: string;
}
export interface Summary {
  year: number; month: number; today: string;
  pending: { total: string; count: number }; paid: { total: string; count: number };
  forecast: { total: string; count: number }; overdue: { total: string; count: number }; dueSoon: { total: string; count: number };
  categoriesActive: number; byCategory: Array<{ categoryId: string; total: string; paid: string; count: number }>;
}
export interface Classification {
  kind: AttachmentSlot | 'unknown'; confidence: 'high' | 'medium' | 'low'; reasons: string[];
  barcode: string | null; amount: string | null; dueDate: string | null; pixCode: string | null; pixKey: string | null;
  beneficiary: string | null; invoiceKey: string | null;
  /** PDF protegido por senha que nenhuma regra do espaço abriu. */
  locked?: boolean;
  /** Nome da regra de senha que abriu o PDF (ele é guardado sem senha). */
  unlockedBy?: string | null;
}

export interface Card {
  id: string; name: string; brand: string; last4: string | null; color: string; limitAmount: string | null;
  closingDay: number; dueDay: number; billCategoryId: string; billFolderId: string | null; holder: string | null; active: boolean;
  limitUsed: string; currentRef: string; currentTotal: string; currentClosing: string; currentDue: string;
}
export interface CardTx {
  id: string; cardId: string; statementId: string; groupId: string; description: string; categoryId: string | null;
  amount: string; totalAmount: string; purchaseDate: string; installmentNumber: number; totalInstallments: number; notes: string | null;
}
export interface StatementView {
  card: Card; ref: string; statement: { id: string | null; ref: string; closingDate: string; dueDate: string; billId: string | null };
  status: 'open' | 'closed' | 'paid'; total: string; bill: Bill | null; items: CardTx[]; refs: string[];
}
