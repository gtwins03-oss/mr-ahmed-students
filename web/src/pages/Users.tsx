import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck, UserCog } from "lucide-react";

import { api, errorMessage } from "../api/client";
import type { PasswordResetInput, User, UserInput, UserRole } from "../api/types";
import { useAuth } from "../lib/auth";
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
} from "../components/ui";
import { arDateTime, arNum } from "../lib/format";

/**
 * OWNER-only account management.
 *
 * The permission model is deliberately blunt: assistants may do *everything*
 * with data and are only kept out of the audit log and this page. That is
 * spelled out at the top of the screen so the teacher knows exactly what he is
 * handing over when he creates an account.
 *
 * A password hash is never sent to the browser and is never rendered here;
 * changing a password means writing a new one, never revealing the old one.
 */

const ROLE_AR: Record<string, string> = {
  OWNER: "مالك",
  ASSISTANT: "مساعد",
};

const MIN_PASSWORD = 6;

type UserForm = {
  id: string | null;
  name: string;
  username: string;
  role: UserRole;
  password: string;
};

const EMPTY_FORM: UserForm = {
  id: null,
  name: "",
  username: "",
  role: "ASSISTANT",
  password: "",
};

type ResetForm = {
  id: string;
  name: string;
  password: string;
};

/** Usernames are typed on a phone keyboard, so keep the rules obvious. */
function usernameError(value: string): string {
  const username = value.trim();
  if (username.length < 3) return "اسم المستخدم يجب أن يكون ٣ أحرف على الأقل.";
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    return "اسم المستخدم بالإنجليزية والأرقام فقط (ويمكن استخدام . _ -).";
  }
  return "";
}

export function Users() {
  const queryClient = useQueryClient();
  const { user: currentUser, isOwner } = useAuth();

  const [form, setForm] = useState<UserForm | null>(null);
  const [formError, setFormError] = useState("");
  const [reset, setReset] = useState<ResetForm | null>(null);
  const [resetError, setResetError] = useState("");
  const [notice, setNotice] = useState("");
  const [rowError, setRowError] = useState("");

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<User[]>("/users"),
    enabled: isOwner,
  });

  const rows = useMemo(() => {
    const list = [...(users.data ?? [])];
    // Owners first, then alphabetically — the teacher's own row stays on top.
    list.sort((a, b) => {
      if (a.role !== b.role) return a.role === "OWNER" ? -1 : 1;
      return (a.name ?? "").localeCompare(b.name ?? "", "ar");
    });
    return list;
  }, [users.data]);

  const activeOwners = rows.filter((row) => row.role === "OWNER" && row.isActive).length;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["users"] });
    queryClient.invalidateQueries({ queryKey: ["audit"] });
  };

  const save = useMutation({
    mutationFn: (payload: { id: string | null; body: UserInput }) =>
      payload.id === null
        ? api.post<User>("/users", payload.body)
        : api.patch<User>(`/users/${payload.id}`, payload.body),
    onSuccess: (_data, variables) => {
      setForm(null);
      setFormError("");
      setNotice(variables.id === null ? "تم إنشاء الحساب." : "تم حفظ التعديلات.");
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const resetPassword = useMutation({
    mutationFn: (payload: { id: string; body: PasswordResetInput }) =>
      api.post<{ ok?: boolean }>(`/users/${payload.id}/password`, payload.body),
    onSuccess: () => {
      setReset(null);
      setResetError("");
      setNotice("تم تعيين كلمة مرور جديدة.");
      invalidate();
    },
    onError: (error) => setResetError(errorMessage(error)),
  });

  const setActive = useMutation({
    mutationFn: (payload: { id: string; isActive: boolean }) =>
      api.patch<User>(`/users/${payload.id}`, { isActive: payload.isActive }),
    onSuccess: (_data, variables) => {
      setRowError("");
      setNotice(variables.isActive ? "تم تفعيل الحساب." : "تم إيقاف الحساب.");
      invalidate();
    },
    onError: (error) => setRowError(errorMessage(error)),
  });

  const submit = () => {
    if (!form) return;

    if (form.name.trim() === "") {
      setFormError("اسم المستخدم الكامل مطلوب.");
      return;
    }
    const badUsername = usernameError(form.username);
    if (badUsername) {
      setFormError(badUsername);
      return;
    }
    if (form.id === null && form.password.length < MIN_PASSWORD) {
      setFormError(`كلمة المرور يجب أن تكون ${arNum(MIN_PASSWORD)} أحرف على الأقل.`);
      return;
    }
    if (form.id !== null && form.id === currentUser?.id && form.role !== "OWNER") {
      setFormError("لا يمكنك تغيير صلاحية حسابك بنفسك.");
      return;
    }

    const body: UserInput = {
      name: form.name.trim(),
      username: form.username.trim(),
      role: form.role,
    };
    if (form.id === null) body.password = form.password;

    setFormError("");
    save.mutate({ id: form.id, body });
  };

  const submitReset = () => {
    if (!reset) return;
    if (reset.password.length < MIN_PASSWORD) {
      setResetError(`كلمة المرور يجب أن تكون ${arNum(MIN_PASSWORD)} أحرف على الأقل.`);
      return;
    }
    setResetError("");
    resetPassword.mutate({ id: reset.id, body: { password: reset.password } });
  };

  const deactivate = (row: User) => {
    if (row.id === currentUser?.id) {
      setRowError("لا يمكنك إيقاف حسابك الحالي.");
      return;
    }
    if (row.role === "OWNER" && activeOwners <= 1) {
      setRowError("يجب أن يبقى حساب مالك واحد نشط على الأقل.");
      return;
    }
    setRowError("");
    setActive.mutate({ id: row.id, isActive: false });
  };

  if (!isOwner) {
    return (
      <div>
        <PageHeader title="المستخدمون" />
        <Card>
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" />}
            title="هذه الصفحة للمالك فقط"
            hint="يمكنك متابعة عملك في الطلاب والحضور والدرجات والرسائل كالمعتاد."
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="المستخدمون"
        subtitle={`${arNum(rows.length)} حساب`}
        actions={
          <Button
            onClick={() => {
              setFormError("");
              setForm({ ...EMPTY_FORM });
            }}
          >
            مستخدم جديد
          </Button>
        }
      />

      <div className="space-y-4">
        <p className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-7 text-blue-900">
          المساعد يستطيع إضافة وتعديل كل شيء — الطلاب والمجموعات والحضور والدرجات والرسائل
          والإعدادات — لكنه لا يرى سجلّ النشاط ولا صفحة المستخدمين.
        </p>

        {notice ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            <span>{notice}</span>
            <button type="button" className="text-xs underline" onClick={() => setNotice("")}>
              إخفاء
            </button>
          </div>
        ) : null}

        {rowError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {rowError}
          </p>
        ) : null}

        {users.isLoading ? (
          <Card>
            <LoadingBlock />
          </Card>
        ) : users.isError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {errorMessage(users.error)}
          </p>
        ) : rows.length === 0 ? (
          <Card bodyClassName="p-0">
            <EmptyState
              icon={<UserCog className="h-6 w-6" />}
              title="لا توجد حسابات بعد"
              hint="أنشئ حساباً للمساعد ليتمكن من تسجيل الحضور وإدخال الدرجات."
              action={
                <Button
                  onClick={() => {
                    setFormError("");
                    setForm({ ...EMPTY_FORM });
                  }}
                >
                  مستخدم جديد
                </Button>
              }
            />
          </Card>
        ) : (
          <Card bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-start text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-start font-bold">الاسم</th>
                    <th className="px-4 py-3 text-start font-bold">اسم المستخدم</th>
                    <th className="px-4 py-3 text-start font-bold">الصلاحية</th>
                    <th className="px-4 py-3 text-start font-bold">الحالة</th>
                    <th className="px-4 py-3 text-start font-bold">آخر دخول</th>
                    <th className="px-4 py-3 text-start font-bold">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => {
                    const isSelf = row.id === currentUser?.id;
                    return (
                      <tr key={row.id} className="align-middle hover:bg-slate-50/60">
                        <td className="px-4 py-3">
                          <span className="font-bold text-slate-900">{row.name || "—"}</span>
                          {isSelf ? (
                            <span className="ms-2 text-xs font-semibold text-slate-400">
                              (أنت)
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <span dir="ltr" className="font-mono text-slate-600">
                            {row.username || "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={row.role === "OWNER" ? "blue" : "gray"}>
                            {ROLE_AR[row.role] ?? row.role}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={row.isActive ? "green" : "gray"}>
                            {row.isActive ? "نشط" : "موقوف"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {arDateTime(row.lastLoginAt)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setFormError("");
                                setForm({
                                  id: row.id,
                                  name: row.name ?? "",
                                  username: row.username ?? "",
                                  role: row.role === "OWNER" ? "OWNER" : "ASSISTANT",
                                  password: "",
                                });
                              }}
                            >
                              تعديل
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setResetError("");
                                setReset({ id: row.id, name: row.name ?? "", password: "" });
                              }}
                            >
                              إعادة تعيين كلمة المرور
                            </Button>
                            {row.isActive ? (
                              <ConfirmButton
                                size="sm"
                                confirmLabel="تأكيد الإيقاف؟"
                                disabled={setActive.isPending}
                                onConfirm={() => deactivate(row)}
                              >
                                إيقاف
                              </ConfirmButton>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={setActive.isPending}
                                onClick={() => setActive.mutate({ id: row.id, isActive: true })}
                              >
                                تفعيل
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* ── Add / edit ────────────────────────────────────────────────── */}
      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? "تعديل المستخدم" : "مستخدم جديد"}
        footer={
          <>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
            <Button variant="ghost" onClick={() => setForm(null)}>
              إلغاء
            </Button>
          </>
        }
      >
        {form ? (
          <div className="space-y-4">
            <Input
              label="الاسم الكامل"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              label="اسم المستخدم"
              dir="ltr"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="assistant1"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <Select
              label="الصلاحية"
              value={form.role}
              onChange={(e) =>
                setForm({
                  ...form,
                  role: e.target.value === "OWNER" ? "OWNER" : "ASSISTANT",
                })
              }
            >
              <option value="ASSISTANT">مساعد</option>
              <option value="OWNER">مالك</option>
            </Select>

            {form.id === null ? (
              <Input
                label="كلمة المرور"
                dir="ltr"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            ) : (
              <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-6 text-slate-500">
                كلمة المرور لا تُعرَض أبداً. لتغييرها استخدم زر «إعادة تعيين كلمة المرور» من
                الجدول.
              </p>
            )}

            <p className="text-xs leading-6 text-slate-500">
              {form.role === "OWNER"
                ? "المالك يرى كل شيء بما في ذلك سجلّ النشاط وإدارة المستخدمين."
                : "المساعد يعمل على كل البيانات، ولا يرى سجلّ النشاط ولا صفحة المستخدمين."}
            </p>

            {formError ? (
              <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
                {formError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* ── Reset password ────────────────────────────────────────────── */}
      <Modal
        open={reset !== null}
        onClose={() => setReset(null)}
        title="إعادة تعيين كلمة المرور"
        footer={
          <>
            <Button onClick={submitReset} disabled={resetPassword.isPending}>
              {resetPassword.isPending ? "جارٍ الحفظ…" : "تعيين كلمة المرور"}
            </Button>
            <Button variant="ghost" onClick={() => setReset(null)}>
              إلغاء
            </Button>
          </>
        }
      >
        {reset ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-slate-600">
              <KeyRound className="h-4 w-4 text-slate-400" />
              كلمة مرور جديدة للحساب: <span className="font-bold text-slate-900">
                {reset.name || "—"}
              </span>
            </p>
            <Input
              label="كلمة المرور الجديدة"
              dir="ltr"
              type="password"
              autoComplete="new-password"
              value={reset.password}
              onChange={(e) => setReset({ ...reset, password: e.target.value })}
            />
            <p className="text-xs leading-6 text-slate-500">
              اكتبها للمستخدم بنفسك — لن تظهر مرة أخرى بعد الحفظ.
            </p>
            {resetError ? (
              <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
                {resetError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default Users;
