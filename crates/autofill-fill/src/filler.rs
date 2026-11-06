use crate::custom_fields::match_custom_fields;
use crate::transformers::{Format, card};
use autofill_autosubmit::{best_submit_button, refuses_enter};
use autofill_clue::field_clue::FORM_RULES;
use autofill_cpd::{CollectedPageDetails, FieldDetails};
use autofill_resolver::pipeline::is_standalone_otp;
use autofill_resolver::{Intent, resolve};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FillIntent {
    #[serde(rename_all = "camelCase")]
    Login {
        #[serde(default)]
        only_empty: bool,
        #[serde(default)]
        password_only: bool,
        /// The item has a code, so a lone one-time-code box can take it.
        #[serde(default)]
        has_totp: bool,
        /// The user's setting, for a fill they asked for. Never on page load.
        #[serde(default)]
        autosubmit: bool,
        /// The names of the item's custom fields; a value's source is `custom:<index>`.
        #[serde(default)]
        custom_fields: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Form {
        /// The value names the item has, empty ones left out.
        keys: Vec<String>,
        #[serde(default)]
        custom_fields: Vec<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillOp {
    pub field_id: u32,
    /// `username`, `password`, `totp` or an HTML autocomplete token.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<Format>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Submit {
    /// Clicked only once `password_field_id` got its value, and only this button: one that is gone by then is not
    /// replaced by Enter, which could press a button nobody looked at.
    #[serde(rename_all = "camelCase")]
    Click {
        field_id: u32,
        password_field_id: u32,
    },
    #[serde(rename_all = "camelCase")]
    Enter { field_id: u32 },
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillPlan {
    pub ops: Vec<FillOp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submit: Option<Submit>,
}

fn op(field: &FieldDetails, source: &str) -> FillOp {
    FillOp {
        field_id: field.field_id,
        source: source.into(),
        format: None,
    }
}

fn plan_login(
    page: &CollectedPageDetails,
    only_empty: bool,
    password_only: bool,
    has_totp: bool,
    autosubmit: bool,
    new_passwords: &mut Vec<u32>,
) -> FillPlan {
    let state = resolve(
        page,
        Intent {
            only_empty,
            password_only,
        },
    );
    if has_totp
        && !only_empty
        && let Some(f) = state.fields.iter().find(|f| {
            f.details.is_active && f.details.is_fillable() && is_standalone_otp(&state, f)
        })
    {
        return FillPlan {
            ops: vec![op(f.details, "totp")],
            submit: None,
        };
    }
    // What the classifier calls a new password (by autocomplete, name or label): a page-load custom field skips it.
    new_passwords.extend(
        state
            .fields
            .iter()
            .filter(|f| f.kind == autofill_clue::LoginKind::New)
            .map(|f| f.details.field_id),
    );
    let choice = state.choice;
    let password = choice.password.map(|i| &state.fields[i]);
    // Page load never fills a username-only step, a new/confirm password, or a sign-up form.
    if only_empty
        && password.is_none_or(|p| {
            p.kind == autofill_clue::LoginKind::New
                || state.forms.get(&p.details.form_id)
                    == Some(&autofill_designation::FormDesignation::Registration)
        })
    {
        return FillPlan::default();
    }
    let mut ops: Vec<FillOp> = vec![];
    if let Some(i) = choice.username {
        ops.push(op(state.fields[i].details, "username"));
    }
    if let Some(p) = password {
        ops.push(op(p.details, "password"));
        if let (false, Some(i)) = (only_empty, choice.confirm) {
            ops.push(op(state.fields[i].details, "password"));
        }
    }
    // Only a login with its password: a username-first step has only just begun.
    let submit = password
        .filter(|_| autosubmit && !only_empty)
        .and_then(|p| match best_submit_button(&page.buttons, p.details) {
            Some(b) => Some(Submit::Click {
                field_id: b.field_id,
                password_field_id: p.details.field_id,
            }),
            // A button the report left out may be the form's own: Enter would press it unseen.
            None if page.buttons_truncated || refuses_enter(&page.buttons, p.details) => None,
            None => Some(Submit::Enter {
                field_id: p.details.field_id,
            }),
        });
    FillPlan { ops, submit }
}

fn plan_form(page: &CollectedPageDetails, keys: &[String]) -> FillPlan {
    let has = |key: &str| keys.iter().any(|k| k == key);
    let mut ops = vec![];
    for f in page.fields.iter().filter(|f| f.is_fillable()) {
        let hint = f.hint();
        let tokens = f.autocomplete_tokens();
        let ac = tokens.last().map_or("", String::as_str);
        let Some(mut key) = (if has(ac) {
            Some(ac)
        } else {
            FORM_RULES
                .iter()
                .find(|(token, re)| has(token) && re.is_match(&hint))
                .map(|(token, _)| *token)
        }) else {
            continue;
        };
        if f.field_type == "textarea" {
            // Only an address fits a free-text box, and it has room for every line.
            if !key.starts_with("street-address") && !key.starts_with("address-line") {
                continue;
            }
            if has("street-address") {
                key = "street-address";
            }
        }
        ops.push(FillOp {
            field_id: f.field_id,
            source: key.into(),
            format: card::format_for(key, f),
        });
    }
    FillPlan { ops, submit: None }
}

/// In the login's form, or without any form in the same block of the page (like autosubmit's buttons).
fn same_login(field: &FieldDetails, login: &FieldDetails) -> bool {
    match login.form_id {
        Some(_) => field.form_id == login.form_id,
        None => field.form_id.is_none() && field.shares_block(&login.block_path),
    }
}

pub fn plan_fill(page: &CollectedPageDetails, intent: &FillIntent) -> FillPlan {
    let mut new_passwords = vec![];
    let (mut plan, names, only_with_login, page_load) = match intent {
        FillIntent::Login {
            only_empty,
            password_only,
            has_totp,
            autosubmit,
            custom_fields,
        } => (
            plan_login(
                page,
                *only_empty,
                *password_only,
                *has_totp,
                *autosubmit,
                &mut new_passwords,
            ),
            custom_fields,
            *only_empty || *password_only,
            *only_empty,
        ),
        FillIntent::Form {
            keys,
            custom_fields,
        } => (plan_form(page, keys), custom_fields, false, false),
    };
    // Page load, and a frame tried for its password form: custom fields come along with a login, never
    // instead of one. Otherwise a match in the top frame would stop the search for a login in an iframe.
    if only_with_login && plan.ops.is_empty() {
        return plan;
    }
    // Nobody asked for a page-load fill, so it stays inside the login it chose: a name that also matches a box of
    // a sign-up or password-change form next to it (the same `password` name) does not reach that box.
    let login = page_load
        .then(|| plan.ops.iter().find(|o| o.source == "password"))
        .flatten()
        .and_then(|o| page.fields.iter().find(|f| f.field_id == o.field_id));
    // The user named these fields, so they go first, and nothing else writes to them.
    let custom: Vec<_> = match_custom_fields(page, names)
        .into_iter()
        .filter(|(id, _)| {
            // Nor a new-password box of the login's own form (a change-password form): a custom field linked to
            // the saved password would put it there unasked.
            login.is_none_or(|p| {
                page.fields
                    .iter()
                    .any(|f| f.field_id == *id && same_login(f, p) && !new_passwords.contains(id))
            })
        })
        .collect();
    plan.ops
        .retain(|o| !custom.iter().any(|(id, _)| *id == o.field_id));
    plan.ops.splice(
        0..0,
        custom.into_iter().map(|(field_id, i)| FillOp {
            field_id,
            source: format!("custom:{i}"),
            format: None,
        }),
    );
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use autofill_cpd::{ButtonDetails, FormDetails};

    fn input(id: u32, ty: &str, name: &str) -> FieldDetails {
        FieldDetails {
            field_id: id,
            form_id: Some(1),
            field_type: ty.into(),
            html_name: Some(name.into()),
            block_path: vec![1],
            ..Default::default()
        }
    }

    fn page(fields: Vec<FieldDetails>) -> CollectedPageDetails {
        CollectedPageDetails {
            origin: "https://a.test".into(),
            forms: vec![FormDetails {
                form_id: 1,
                ..Default::default()
            }],
            fields,
            ..Default::default()
        }
    }

    fn login(only_empty: bool, autosubmit: bool) -> FillIntent {
        FillIntent::Login {
            only_empty,
            password_only: false,
            has_totp: false,
            autosubmit,
            custom_fields: vec![],
        }
    }

    fn sources(plan: &FillPlan) -> Vec<(u32, &str)> {
        plan.ops
            .iter()
            .map(|o| (o.field_id, o.source.as_str()))
            .collect()
    }

    #[test]
    fn page_load_skips_a_sign_up_form() {
        let mut p = page(vec![
            input(1, "email", "email"),
            input(2, "password", "password"),
        ]);
        p.buttons.push(ButtonDetails {
            field_id: 3,
            form_id: Some(1),
            text: Some("Create account".into()),
            is_submit: true,
            ..Default::default()
        });
        assert!(plan_fill(&p, &login(true, false)).ops.is_empty());
        assert!(
            !plan_fill(&p, &login(false, false)).ops.is_empty(),
            "a fill the user asked for still works"
        );
    }

    #[test]
    fn a_login() {
        let p = page(vec![
            input(1, "text", "username"),
            input(2, "password", "password"),
        ]);
        assert_eq!(
            sources(&plan_fill(&p, &login(false, false))),
            [(1, "username"), (2, "password")]
        );
    }

    #[test]
    fn page_load_skips_a_username_step_and_a_new_password() {
        let p = page(vec![input(1, "text", "username")]);
        assert!(plan_fill(&p, &login(true, false)).ops.is_empty());
        let mut new = input(2, "password", "password");
        new.autocomplete_type = Some("new-password".into());
        assert!(
            plan_fill(&page(vec![new]), &login(true, false))
                .ops
                .is_empty()
        );
    }

    #[test]
    fn hidden_fields_never_take_a_value() {
        let mut hidden = input(2, "password", "password");
        hidden.is_hidden = true;
        assert_eq!(
            sources(&plan_fill(
                &page(vec![input(1, "text", "username"), hidden]),
                &login(false, false)
            )),
            [(1, "username")]
        );
    }

    #[test]
    fn the_code_goes_in_the_box_the_user_is_in() {
        let mut otp = input(1, "text", "otp");
        otp.is_active = true;
        let totp = FillIntent::Login {
            only_empty: false,
            password_only: false,
            has_totp: true,
            autosubmit: true,
            custom_fields: vec![],
        };
        let plan = plan_fill(&page(vec![otp.clone()]), &totp);
        assert_eq!(sources(&plan), [(1, "totp")]);
        assert!(plan.submit.is_none());
        // No code on the item: an OTP box is not an account field.
        assert!(
            plan_fill(&page(vec![otp]), &login(false, false))
                .ops
                .is_empty()
        );
    }

    #[test]
    fn autosubmit_clicks_the_button_or_presses_enter() {
        let mut p = page(vec![
            input(1, "text", "username"),
            input(2, "password", "password"),
        ]);
        assert!(matches!(
            plan_fill(&p, &login(false, true)).submit,
            Some(Submit::Enter { field_id: 2 })
        ));
        assert!(plan_fill(&p, &login(false, false)).submit.is_none());
        assert!(
            plan_fill(&p, &login(true, true)).submit.is_none(),
            "never on page load"
        );
        p.buttons.push(ButtonDetails {
            field_id: 3,
            form_id: Some(1),
            text: Some("Sign in".into()),
            is_submit: true,
            ..Default::default()
        });
        assert!(matches!(
            plan_fill(&p, &login(false, true)).submit,
            Some(Submit::Click {
                field_id: 3,
                password_field_id: 2
            })
        ));
        p.buttons[0].text = Some("Reset password".into());
        assert!(
            plan_fill(&p, &login(false, true)).submit.is_none(),
            "Enter would press the reset button"
        );
        let step = page(vec![input(1, "text", "username")]);
        assert!(
            plan_fill(&step, &login(false, true)).submit.is_none(),
            "a username step has only begun"
        );
        p.buttons.clear();
        p.buttons_truncated = true;
        assert!(
            plan_fill(&p, &login(false, true)).submit.is_none(),
            "the form's own button may be one the report left out"
        );
    }

    #[test]
    fn a_form_fill_uses_the_token_then_the_text() {
        let mut number = input(1, "text", "x");
        number.autocomplete_type = Some("billing cc-number".into());
        number.max_length = Some(19);
        let mut name = input(2, "text", "x");
        name.label = Some("Name on card".into());
        let keys = FillIntent::Form {
            keys: vec!["cc-number".into(), "cc-name".into()],
            custom_fields: vec![],
        };
        let plan = plan_fill(&page(vec![number, name, input(3, "text", "other")]), &keys);
        assert_eq!(sources(&plan), [(1, "cc-number"), (2, "cc-name")]);
        assert_eq!(plan.ops[0].format, Some(Format::Digits));
    }

    #[test]
    fn a_textarea_only_takes_an_address() {
        let mut address = input(1, "textarea", "x");
        address.label = Some("Street address".into());
        let mut note = input(2, "textarea", "x");
        note.label = Some("Email us about your name".into());
        let keys = FillIntent::Form {
            keys: vec![
                "street-address".into(),
                "address-line1".into(),
                "email".into(),
                "name".into(),
            ],
            custom_fields: vec![],
        };
        assert_eq!(
            sources(&plan_fill(&page(vec![address, note]), &keys)),
            [(1, "street-address")]
        );
    }

    fn with_custom(
        page: &CollectedPageDetails,
        only_empty: bool,
        password_only: bool,
        names: &[&str],
    ) -> FillPlan {
        let custom_fields = names.iter().map(|n| n.to_string()).collect();
        plan_fill(
            page,
            &FillIntent::Login {
                only_empty,
                password_only,
                has_totp: false,
                autosubmit: false,
                custom_fields,
            },
        )
    }

    #[test]
    fn custom_fields_come_first_and_replace_what_they_match() {
        let p = page(vec![
            input(1, "text", "username"),
            input(2, "password", "password"),
            input(3, "text", "pin"),
        ]);
        assert_eq!(
            sources(&with_custom(&p, false, false, &["pin", "username"])),
            [(1, "custom:1"), (3, "custom:0"), (2, "password")]
        );
    }

    #[test]
    fn custom_fields_alone_only_when_asked_for() {
        let p = page(vec![input(1, "text", "pin")]);
        assert_eq!(
            sources(&with_custom(&p, false, false, &["pin"])),
            [(1, "custom:0")]
        );
        assert!(
            with_custom(&p, true, false, &["pin"]).ops.is_empty(),
            "page load needs a login"
        );
        assert!(
            with_custom(&p, false, true, &["pin"]).ops.is_empty(),
            "the login may be in an iframe"
        );
        let login = page(vec![
            input(1, "text", "pin"),
            input(2, "password", "password"),
        ]);
        assert_eq!(
            sources(&with_custom(&login, true, false, &["pin"])),
            [(1, "custom:0"), (2, "password")]
        );
    }

    #[test]
    fn page_load_custom_fields_stay_in_the_login_it_fills() {
        // A login form, and a password-change form whose new password box has the same name.
        let mut new = input(4, "password", "password");
        new.form_id = Some(2);
        new.block_path = vec![2];
        new.autocomplete_type = Some("new-password".into());
        let mut p = page(vec![
            input(1, "text", "username"),
            input(2, "password", "password"),
            new,
        ]);
        p.forms.push(FormDetails {
            form_id: 2,
            ..Default::default()
        });
        let ids = |plan: FillPlan| plan.ops.iter().map(|o| o.field_id).collect::<Vec<_>>();
        let page_load = ids(with_custom(&p, true, false, &["password"]));
        assert!(
            page_load.contains(&2) && !page_load.contains(&4),
            "{page_load:?}"
        );
        assert!(
            ids(with_custom(&p, false, false, &["password"])).contains(&4),
            "a fill the user asked for goes wherever the name matches"
        );
    }

    #[test]
    fn page_load_custom_fields_skip_a_new_password_of_the_same_form() {
        let mut current = input(2, "password", "current");
        current.autocomplete_type = Some("current-password".into());
        let mut new = input(3, "password", "secret");
        new.autocomplete_type = Some("new-password".into());
        let p = page(vec![input(1, "text", "username"), current, new]);
        let ids = |plan: FillPlan| plan.ops.iter().map(|o| o.field_id).collect::<Vec<_>>();
        let page_load = ids(with_custom(&p, true, false, &["secret"]));
        assert!(!page_load.contains(&3), "{page_load:?}");
        // The new box named only (no autocomplete on it).
        let mut current = input(2, "password", "current");
        current.autocomplete_type = Some("current-password".into());
        let named = page(vec![
            input(1, "text", "username"),
            current,
            input(3, "password", "newPassword"),
        ]);
        let page_load = ids(with_custom(&named, true, false, &["newPassword"]));
        assert!(!page_load.contains(&3), "{page_load:?}");
    }

    #[test]
    fn a_form_fill_takes_custom_fields() {
        let keys = FillIntent::Form {
            keys: vec![],
            custom_fields: vec!["member".into()],
        };
        assert_eq!(
            sources(&plan_fill(&page(vec![input(1, "text", "member")]), &keys)),
            [(1, "custom:0")]
        );
    }

    #[test]
    fn intents_parse_from_json() {
        let intent: FillIntent =
            serde_json::from_str(r#"{"kind":"login","onlyEmpty":true,"hasTotp":false}"#).unwrap();
        assert!(matches!(
            intent,
            FillIntent::Login {
                only_empty: true,
                ..
            }
        ));
        let intent: FillIntent =
            serde_json::from_str(r#"{"kind":"form","keys":["tel"],"customFields":["a"]}"#).unwrap();
        assert!(matches!(intent, FillIntent::Form { custom_fields, .. } if custom_fields == ["a"]));
    }
}
