export const metadata = {
  title: 'Checkout Workflow MCP',
  description: 'MCP server for triggering checkout-agent GitHub Actions workflow'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
