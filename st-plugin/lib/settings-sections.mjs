// SPDX-License-Identifier: AGPL-3.0-only
export const SECTION_FILES = Object.freeze({
    core: 'default-user/settings.json',
    appearance: 'default-user/settings/appearance.json',
    presets: 'default-user/settings/presets.json',
    layout: 'default-user/settings/layout.json',
    persona_state: 'default-user/settings/persona-state.json',
});

const APPEARANCE_FIELDS = [
    [[], ['background']],
    [['power_user'], [
        'theme', 'theme_fallback', 'theme_bindings', 'blur_strength', 'main_text_color',
        'italics_text_color', 'underline_text_color', 'quote_text_color', 'blur_tint_color',
        'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color', 'shadow_color',
        'shadow_width', 'border_color', 'font_scale', 'fast_ui_mode', 'waifuMode', 'avatar_style',
        'chat_display', 'toastr_position', 'noShadows', 'chat_width', 'timer_enabled',
        'timestamps_enabled', 'timestamp_model_icon', 'mesIDDisplay_enabled', 'hideChatAvatars_enabled',
        'message_token_count_enabled', 'message_ttft_enabled', 'message_token_rate_enabled',
        'message_cache_enabled', 'expand_message_actions', 'enableZenSliders', 'enableLabMode',
        'hotswap_enabled', 'custom_css', 'bogus_folders', 'zoomed_avatar_magnification',
        'reduced_motion', 'compact_input_area', 'show_swipe_num_all_messages', 'click_to_edit',
        'media_display',
    ]],
];

const PRESET_FIELDS = [
    [[], [
        'main_api', 'selected_proxy', 'amount_gen', 'max_context', 'oai_settings', 'nai_settings',
        'kai_settings', 'textgenerationwebui_settings', 'horde_settings', 'preset_settings',
        'preset_settings_novel',
    ]],
    [['power_user'], ['instruct', 'context', 'sysprompt', 'reasoning']],
    [['extension_settings', 'connectionManager'], ['selectedProfile', 'selectedItem']],
];

const PERSONA_STATE_FIELDS = [
    [[], ['username', 'user_avatar']],
    [['power_user'], [
        'default_persona', 'persona_description', 'persona_description_position',
        'persona_description_depth', 'persona_description_role', 'persona_description_lorebook',
        'persona_show_notifications', 'persona_auto_lock', 'persona_allow_multi_connections',
    ]],
];

const LAYOUT_FIELDS = [
    [[], ['firstRun', 'currentVersion', 'active_character', 'active_group', 'selected_button']],
    [['power_user'], [
        'movingUI', 'movingUIState', 'movingUIPreset', 'mobile_immersive_fullscreen', 'charListGrid',
        'sort_field', 'sort_order', 'sort_rule', 'persona_sort_order', 'show_tag_filters',
        'show_tag_filters_group_candidates', 'show_tag_filters_group_members', 'aux_field',
    ]],
    [['accountStorage'], [
        'Characters_PerPage', 'Personas_PerPage', 'Personas_GridView', 'GroupMembers_PerPage',
        'GroupCandidates_PerPage', 'FeatherlessModels_PerPage', 'WI_PerPage', 'WINavLockOn',
        'WINavOpened', 'LNavLockOn', 'LNavOpened', 'NavLockOn', 'NavOpened', 'SelectedNavTab',
        'characterSearchFormVisible', 'world_info_sort_order', 'DataBank_sortField', 'DataBank_sortOrder',
    ]],
];

const GROUPS = {
    appearance: APPEARANCE_FIELDS,
    presets: PRESET_FIELDS,
    layout: LAYOUT_FIELDS,
    persona_state: PERSONA_STATE_FIELDS,
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function moveFields(source, target, groups) {
    for (const [parents, fields] of groups) {
        let sourceObject = source;
        for (const key of parents) {
            sourceObject = isObject(sourceObject) ? sourceObject[key] : undefined;
        }
        if (!isObject(sourceObject)) continue;
        for (const field of fields) {
            if (!Object.prototype.hasOwnProperty.call(sourceObject, field)) continue;
            const value = sourceObject[field];
            delete sourceObject[field];
            let targetParent = target;
            for (const parent of parents) {
                if (!isObject(targetParent[parent])) targetParent[parent] = {};
                targetParent = targetParent[parent];
            }
            targetParent[field] = value;
        }
    }
}

export function splitSettings(settings) {
    const core = structuredClone(isObject(settings) ? settings : {});
    const sections = { core, appearance: {}, presets: {}, layout: {}, persona_state: {} };
    for (const [name, groups] of Object.entries(GROUPS)) {
        moveFields(core, sections[name], groups);
    }
    return sections;
}

export function mergeSettings(sections) {
    const core = structuredClone(isObject(sections.core) ? sections.core : {});
    for (const [name, groups] of Object.entries(GROUPS)) {
        const section = structuredClone(isObject(sections[name]) ? sections[name] : {});
        moveFields(section, core, groups);
    }
    return core;
}

export function applyDownloadedSections(localSettings, downloaded) {
    const local = splitSettings(localSettings);
    const result = { ...local };
    let fromCore = null;
    if (downloaded.core !== undefined) {
        fromCore = splitSettings(downloaded.core);
        result.core = fromCore.core;
    }
    for (const name of Object.keys(GROUPS)) {
        if (fromCore && Object.keys(fromCore[name]).length > 0) {
            result[name] = fromCore[name];
        } else if (downloaded[name] !== undefined) {
            result[name] = isObject(downloaded[name]) ? downloaded[name] : {};
        }
    }
    return mergeSettings(result);
}

export function serializeSection(value) {
    return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}
