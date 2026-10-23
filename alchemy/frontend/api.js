export async function api(path, body) {
  let response;
  try {
    response = await fetch(`/api/alchemy${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (error) {
    error.uncertain = body !== undefined;
    throw error;
  }
  let result;
  try {
    result = await response.json();
  } catch {
    const error = Error(
      "저장 응답을 해석하지 못했습니다. 결과를 재확인하세요.",
    );
    error.uncertain = body !== undefined;
    throw error;
  }
  if (!response.ok) {
    const error = Error(result.error?.message ?? "요청에 실패했습니다.");
    error.status = response.status;
    throw error;
  }
  return result;
}
