-- usage_status는 로그인한 사용자만
revoke execute on function public.usage_status() from anon;
