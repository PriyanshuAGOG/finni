import { handleApiRequest } from '../../../../api/handler';
import { registerOperations } from '../../../../api/operations';

registerOperations();

export async function GET(request: Request) {
  return handleApiRequest(request);
}
export async function POST(request: Request) {
  return handleApiRequest(request);
}
export async function PATCH(request: Request) {
  return handleApiRequest(request);
}
export async function PUT(request: Request) {
  return handleApiRequest(request);
}
export async function DELETE(request: Request) {
  return handleApiRequest(request);
}
