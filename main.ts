import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    Notice,
    normalizePath,
    TFolder,
    debounce,
    Debouncer,
    TAbstractFile
} from 'obsidian';

// --- Interfaces & Settings ---

type ScopeMode = 'vault' | 'include' | 'exclude';
type LocationMode = 'pattern' | 'original'; // New option for "Move" vs "Leave as is"

interface AttachmentRule {
    id: string;
    label: string;
    extensions: string[]; // e.g. ['png', 'jpg']
    namePattern: string;  // e.g. ${filename}-${index}
    pathPattern: string;  // e.g. ./assets OR attachments/images
    locationMode: LocationMode; // New property
}

interface PluginSettings {
    scopeMode: ScopeMode;
    watchedPaths: string[]; 
    rules: AttachmentRule[];
    defaultNamePattern: string;
    defaultPathPattern: string;
    enableAutoRename: boolean;
    debounceDelay: number;
}

const DEFAULT_SETTINGS: PluginSettings = {
    scopeMode: 'vault',
    watchedPaths: ['Projects/Active'],
    defaultNamePattern: '${filename} ${original}',
    defaultPathPattern: './attachments',
    enableAutoRename: true,
    debounceDelay: 2000, 
    rules: [
        {
            id: 'default-image',
            label: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'],
            namePattern: '${filename} ${original}',
            pathPattern: './assets',
            locationMode: 'pattern'
        },
        {
            id: 'default-pdf',
            label: 'PDFs',
            extensions: ['pdf'],
            namePattern: '${filename} ${original}',
            pathPattern: 'Documents/Attachments',
            locationMode: 'pattern'
        }
    ]
};

interface AttachmentInfo {
    file: TFile;
    originalPath: string;
    index: number;
}

export default class AttachmentManagerPlugin extends Plugin {
    settings: PluginSettings;
    
    // Locks to prevent infinite loops
    private isProcessing = new Set<string>();
    
    // Map to hold debounced functions per file path. 
    private debouncers = new Map<string, Debouncer<[TFile, string | null], void>>();

    async onload() {
        await this.loadSettings();

        // 1. Command: Manual Trigger (Active Note)
        this.addCommand({
            id: 'rename-attachments-active',
            name: 'Rename attachments for active note',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    if (!checking) {
                        if (!this.isScopeValid(file.path)) {
                            new Notice('Note is outside the configured scope.');
                            return;
                        }
                        this.processNoteAttachments(file, null);
                    }
                    return true;
                }
                return false;
            }
        });

        // 2. Command: Manual Trigger (All Notes in Scope)
        this.addCommand({
            id: 'rename-attachments-all',
            name: 'Rename attachments for all notes in scope',
            callback: async () => {
                await this.processAllNotesInScope();
            }
        });

        // 3. Settings Tab
        this.addSettingTab(new AttachmentSettingTab(this.app, this));

        // 4. Event: On Note Rename
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (!this.settings.enableAutoRename) return;
                
                if (file instanceof TFile && file.extension === 'md') {
                    if (this.isScopeValid(file.path)) {
                        const oldNoteName = this.getFileNameFromPath(oldPath);
                        this.triggerDebouncedProcessing(file, oldNoteName);
                    }
                }
            })
        );

        console.log('[Attachment Manager] Plugin Loaded');
    }

    async onunload() {
        for (const debouncer of this.debouncers.values()) {
            debouncer.cancel();
        }
        this.debouncers.clear();
        this.isProcessing.clear();
    }

    private getFileNameFromPath(path: string): string {
        const parts = path.split('/');
        const fileNameWithExt = parts[parts.length - 1];
        return fileNameWithExt.replace(/\.md$/, '');
    }

    private triggerDebouncedProcessing(file: TFile, oldNoteName: string) {
        let debouncer = this.debouncers.get(file.path);
        
        if (!debouncer) {
            debouncer = debounce(
                (f: TFile, oldName: string | null) => {
                    this.processNoteAttachments(f, oldName);
                    this.debouncers.delete(f.path);
                }, 
                this.settings.debounceDelay, 
                true
            );
            this.debouncers.set(file.path, debouncer);
        }

        debouncer(file, oldNoteName);
    }

    async processAllNotesInScope() {
        const allFiles = this.app.vault.getMarkdownFiles();
        const filesInScope = allFiles.filter(file => this.isScopeValid(file.path));

        if (filesInScope.length === 0) {
            new Notice('No notes found in the configured scope');
            return;
        }

        new Notice(`Processing ${filesInScope.length} notes...`);
        let totalRenamed = 0;

        for (const file of filesInScope) {
            const count = await this.processNoteAttachments(file, null);
            totalRenamed += count;
        }

        new Notice(`✅ Processed ${filesInScope.length} notes, renamed ${totalRenamed} attachments`);
    }

    /**
     * Main Logic: Process the note and rename its embeds/links
     */
    async processNoteAttachments(noteFile: TFile, oldNoteName: string | null): Promise<number> {
        if (this.isProcessing.has(noteFile.path)) return 0;
        this.isProcessing.add(noteFile.path);

        try {
            // 1. Safe Cache Retrieval
            let cache = this.app.metadataCache.getFileCache(noteFile);
            let retries = 0;
            const maxRetries = 10;
            
            while (!cache && retries < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 100));
                cache = this.app.metadataCache.getFileCache(noteFile);
                retries++;
            }

            if (!cache) return 0;

            const combinedReferences = [
                ...(cache.embeds || []),
                ...(cache.links || [])
            ];

            if (combinedReferences.length === 0) return 0;

            // 2. Gather Data
            const targets: AttachmentInfo[] = [];

            for (let i = 0; i < combinedReferences.length; i++) {
                const ref = combinedReferences[i];
                const cleanLink = ref.link.split('#')[0].split('^')[0];
                const attachmentFile = this.app.metadataCache.getFirstLinkpathDest(cleanLink, noteFile.path);

                if (attachmentFile instanceof TFile && 
                    attachmentFile.extension !== 'md' && 
                    attachmentFile.path !== noteFile.path) {
                    
                    targets.push({
                        file: attachmentFile,
                        originalPath: attachmentFile.path,
                        index: i
                    });
                }
            }

            if (targets.length === 0) return 0;

            // 3. Process Renames
            const processedPaths = new Set<string>();
            // Optimization: Cache folders we know exist so we don't spam checks
            const checkedFolders = new Set<string>(); 
            let renameCount = 0;

            for (const { file: attachmentFile, originalPath, index } of targets) {
                if (processedPaths.has(attachmentFile.path)) continue;

                if (!this.app.vault.getAbstractFileByPath(attachmentFile.path)) continue;

                const rule = this.getRuleForExtension(attachmentFile.extension);
                
                // Safe Allowlist approach
                if (!rule && this.settings.rules.length > 0) continue; 

                const namePattern = rule ? rule.namePattern : this.settings.defaultNamePattern;
                const pathPattern = rule ? rule.pathPattern : this.settings.defaultPathPattern;
                
                // === NEW LOGIC: Location Mode ===
                // If rule exists, use its mode, otherwise default to 'pattern' (move)
                const locationMode: LocationMode = rule ? (rule.locationMode || 'pattern') : 'pattern';

                const cleanOriginalBase = this.getCleanOriginalName(attachmentFile.basename, oldNoteName);

                const variables = {
                    filename: noteFile.basename,
                    original: cleanOriginalBase,
                    extension: attachmentFile.extension,
                    date: this.getFormattedDate(),
                    index: (index + 1).toString().padStart(2, '0')
                };

                let newBaseName = this.sanitizeName(this.applyVariables(namePattern, variables));
                if (newBaseName.length === 0) newBaseName = 'attachment';

                const newFileName = `${newBaseName}.${attachmentFile.extension}`;
                
                // === LOGIC: Determine Target Folder ===
                let targetFolderPath: string;
                
                if (locationMode === 'original') {
                    // OPTION: Leave as is (Keep in current parent folder)
                    targetFolderPath = attachmentFile.parent ? attachmentFile.parent.path : '/';
                } else {
                    // OPTION: Move using Pattern (e.g. ./templates)
                    targetFolderPath = this.resolveTargetPath(pathPattern, noteFile);
                }

                const desiredPath = normalizePath(`${targetFolderPath}/${newFileName}`);

                if (desiredPath === attachmentFile.path) {
                    processedPaths.add(attachmentFile.path);
                    continue;
                }

                const finalPath = await this.resolveCollision(
                    desiredPath, 
                    attachmentFile, 
                    targetFolderPath, 
                    newBaseName
                );

                if (finalPath === attachmentFile.path) {
                    processedPaths.add(attachmentFile.path);
                    continue;
                }

                try {
                    // Optimization: Only check folder existence if we haven't checked this folder in this batch
                    if (!checkedFolders.has(targetFolderPath) && locationMode !== 'original') {
                        await this.ensureFolderExists(targetFolderPath);
                        checkedFolders.add(targetFolderPath);
                    }
                    
                    console.log(`[Attachment Manager] Renaming: ${attachmentFile.name} -> ${finalPath}`);
                    await this.app.fileManager.renameFile(attachmentFile, finalPath);
                    
                    processedPaths.add(finalPath);
                    renameCount++;
                    
                } catch (err) {
                    console.error(`[Attachment Manager] Error renaming ${originalPath}`, err);
                }
            }

            if (renameCount > 0) {
                console.log(`[Attachment Manager] Renamed ${renameCount} files for ${noteFile.basename}`);
            }
            return renameCount;

        } catch (e) {
            console.error("[Attachment Manager] Error:", e);
            return 0;
        } finally {
            this.isProcessing.delete(noteFile.path);
        }
    }

    getCleanOriginalName(currentBase: string, oldNoteName: string | null): string {
        if (!oldNoteName) return currentBase;
        let clean = currentBase;
        if (clean.includes(oldNoteName)) {
            const escapedOld = oldNoteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
            const regex = new RegExp(`[\\s-_]*${escapedOld}[\\s-_]*`, 'g');
            clean = clean.replace(regex, ' ').trim();
        }
        if (clean === '') clean = 'Attachment'; 
        return clean;
    }

    private resolveTargetPath(pathPattern: string, noteFile: TFile): string {
        if (pathPattern.startsWith('./')) {
            const parentPath = noteFile.parent ? noteFile.parent.path : '/';
            const cleanRel = pathPattern.substring(2);
            if (parentPath === '/') return normalizePath(cleanRel);
            return normalizePath(`${parentPath}/${cleanRel}`);
        } else {
            return normalizePath(pathPattern);
        }
    }

    private async resolveCollision(
        desiredPath: string, 
        currentFile: TFile,
        targetFolder: string,
        baseName: string
    ): Promise<string> {
        let finalPath = desiredPath;
        let suffix = 0;
        const maxRetries = 500;
        const ext = currentFile.extension;

        while (suffix < maxRetries) {
            const existing = this.app.vault.getAbstractFileByPath(finalPath);
            if (!existing) return finalPath;
            if (existing.path === currentFile.path) return finalPath;

            suffix++;
            finalPath = normalizePath(`${targetFolder}/${baseName} ${suffix}.${ext}`);
        }
        return currentFile.path;
    }

    isScopeValid(filePath: string): boolean {
        const { scopeMode, watchedPaths } = this.settings;
        if (scopeMode === 'vault') return true;
        const normalizedFilePath = normalizePath(filePath);
        const validWatchedPaths = watchedPaths
            .map(p => normalizePath(p))
            .filter(p => p !== '' && p !== '/');
        if (validWatchedPaths.length === 0) return true;
        const isMatch = validWatchedPaths.some(folder => 
            normalizedFilePath === folder || normalizedFilePath.startsWith(folder + '/')
        );
        if (scopeMode === 'include') return isMatch;
        if (scopeMode === 'exclude') return !isMatch;
        return true;
    }

    getRuleForExtension(ext: string): AttachmentRule | null {
        const lowerExt = ext.toLowerCase();
        return this.settings.rules.find(r => 
            r.extensions.some(e => e.toLowerCase() === lowerExt)
        ) || null;
    }

    applyVariables(pattern: string, vars: { [key: string]: string }): string {
        return pattern
            .replace(/\$\{filename\}/g, vars.filename || 'note')
            .replace(/\$\{original\}/g, vars.original || 'file')
            .replace(/\$\{extension\}/g, vars.extension || '')
            .replace(/\$\{date\}/g, vars.date || '')
            .replace(/\$\{index\}/g, vars.index || '01');
    }

    private getFormattedDate(): string {
        const d = new Date();
        const year = d.getFullYear();
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        return `${year}${month}${day}`;
    }

    sanitizeName(name: string): string {
        return name.replace(/[\\/:"*?<>|]+/g, '-').replace(/\s+/g, ' ').trim();
    }

    async ensureFolderExists(path: string): Promise<void> {
        if (!path || path === '/' || path === '.') return;
        const normalized = normalizePath(path);
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing) {
            if (existing instanceof TFolder) return;
            throw new Error(`Cannot create folder "${normalized}" because a file exists with that name.`);
        }
        await this.app.vault.createFolder(normalized);
    }

    async loadSettings() {
        const loaded = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
        if (loaded?.rules) {
            // Backward compatibility: ensure locationMode exists
            this.settings.rules = loaded.rules.map((r: any) => ({
                ...r,
                locationMode: r.locationMode || 'pattern' 
            }));
        }
        if (loaded?.watchedPaths) this.settings.watchedPaths = loaded.watchedPaths;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// --- Settings UI ---

class AttachmentSettingTab extends PluginSettingTab {
    plugin: AttachmentManagerPlugin;

    constructor(app: App, plugin: AttachmentManagerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Attachment Manager' });

        // General
        containerEl.createEl('h3', { text: 'General' });
        new Setting(containerEl)
            .setName('Enable Auto-Rename')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAutoRename)
                .onChange(async (val) => {
                    this.plugin.settings.enableAutoRename = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Debounce Delay (ms)')
            .addText(text => text
                .setPlaceholder('2000')
                .setValue(String(this.plugin.settings.debounceDelay))
                .onChange(async (val) => {
                    const num = parseInt(val);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.debounceDelay = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // Scope
        containerEl.createEl('h3', { text: 'Scope' });
        new Setting(containerEl)
            .setName('Operation Mode')
            .addDropdown(drop => drop
                .addOption('vault', 'Entire Vault')
                .addOption('include', 'Only in Watched Folders')
                .addOption('exclude', 'Everywhere EXCEPT Ignored Folders')
                .setValue(this.plugin.settings.scopeMode)
                .onChange(async (val) => {
                    this.plugin.settings.scopeMode = val as ScopeMode;
                    await this.plugin.saveSettings();
                    this.display(); 
                }));

        if (this.plugin.settings.scopeMode !== 'vault') {
            const label = this.plugin.settings.scopeMode === 'include' ? 'Watched Folders' : 'Ignored Folders';
            new Setting(containerEl)
                .setName(label)
                .setDesc('One folder path per line')
                .addTextArea(text => text
                    .setPlaceholder('Projects/Active')
                    .setValue(this.plugin.settings.watchedPaths.join('\n'))
                    .onChange(async (val) => {
                        this.plugin.settings.watchedPaths = val.split('\n').map(x => x.trim()).filter(x => x);
                        await this.plugin.saveSettings();
                    }));
        }

        // Rules
        containerEl.createEl('h3', { text: 'Extension Rules' });
        
        this.plugin.settings.rules.forEach((rule, idx) => {
            const ruleDiv = containerEl.createDiv();
            ruleDiv.style.borderTop = '1px solid var(--background-modifier-border)';
            ruleDiv.style.padding = '10px 0';

            new Setting(ruleDiv)
                .setName(`Rule #${idx + 1}`)
                .setHeading()
                .addButton(btn => btn
                    .setIcon('trash')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.rules.splice(idx, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            new Setting(ruleDiv).setName('Label').addText(t => t.setValue(rule.label).onChange(async v => { rule.label = v; await this.plugin.saveSettings(); }));
            new Setting(ruleDiv).setName('Extensions').setDesc('e.g. png, jpg').addText(t => t.setValue(rule.extensions.join(', ')).onChange(async v => { 
                rule.extensions = v.split(',').map(e => e.trim()).filter(e => e); 
                await this.plugin.saveSettings(); 
            }));
            
            // --- NEW: Location Mode Dropdown ---
            new Setting(ruleDiv)
                .setName('Location Strategy')
                .setDesc('Move file to pattern folder OR leave where it is.')
                .addDropdown(drop => drop
                    .addOption('pattern', 'Move to Defined Pattern')
                    .addOption('original', 'Leave in Original Folder')
                    .setValue(rule.locationMode || 'pattern')
                    .onChange(async (val) => {
                        rule.locationMode = val as LocationMode;
                        await this.plugin.saveSettings();
                        // Refresh to show/hide path pattern if needed, though simpler to keep UI static
                        this.display(); 
                    })
                );

            // Only show Path Pattern if mode is 'pattern'
            if (!rule.locationMode || rule.locationMode === 'pattern') {
                new Setting(ruleDiv)
                    .setName('Location Pattern')
                    .setDesc('Use "./" for relative path. (e.g. ./templates)')
                    .addText(t => t.setValue(rule.pathPattern).onChange(async v => { rule.pathPattern = v; await this.plugin.saveSettings(); }));
            }

            new Setting(ruleDiv).setName('Name Pattern').addText(t => t.setValue(rule.namePattern).onChange(async v => { rule.namePattern = v; await this.plugin.saveSettings(); }));
        });

        new Setting(containerEl)
            .addButton(btn => btn
                .setButtonText('+ Add Rule')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.rules.push({
                        id: Date.now().toString(),
                        label: 'New Rule',
                        extensions: [],
                        namePattern: '${filename} ${original}',
                        pathPattern: './attachments',
                        locationMode: 'pattern' // Default
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }
}