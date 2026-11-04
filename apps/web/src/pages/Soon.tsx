import { Hourglass } from 'lucide-react';
import { Card, Empty, PageHeader } from '@/components/ui/base';

export function SoonPage({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} />
      <Card><Empty icon={<Hourglass className="size-5" />} title="Em construção">{text}</Empty></Card>
    </div>
  );
}
