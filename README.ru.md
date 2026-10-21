# ZFS Director

[English](README.md) · **Русский**

Управление ZFS в Unraid, **файловый менеджер snapshots**, автоматические политики **Sanoid** и **мастер репликации Syncoid** в одном интерфейсе.

- **[Snapshot File Manager](#snapshot-file-manager):** откройте snapshot как папку, найдите и выберите файлы, скачайте ZIP или восстановите выбранное после проверки.
- **[Интеграция Sanoid](#политики-sanoid):** задайте время создания snapshots, хранение и безопасное удаление старых копий; просматривайте External и Managed policies.
- **[Интеграция Syncoid](#репликация-syncoid):** настройте локальную или SSH-репликацию через Source → Destination → Schedule → Review; progress и проверенный результат доступны в Jobs.

**[Скачать установочный ZIP для Unraid](https://github.com/d1-m4ss/zfs-director/releases/download/2026.10.22.1/ZFS-Director-2026.10.22.1-Unraid-RC1.zip)** · [SHA256SUMS](https://github.com/d1-m4ss/zfs-director/releases/download/2026.10.22.1/SHA256SUMS) · [Установка и rollback](docs/INSTALLATION.md) · [Ограничения](#состояние-релиза-и-известные-ограничения)

**RC1 2026.10.22.1**, целевое окружение — Unraid 7.3.3 / OpenZFS 2.4.4. Это ещё не стабильный релиз и не публикация в Community Applications. На всех скриншотах вымышленные данные, снятые внутри изолированной VM; [подробности съёмки](docs/TESTING.md#documentation-screenshots).

Результаты установки, реальных ZFS-операций и GUI-проверок приведены в [сводке проверки RC1](docs/TESTING.md#rc1-verification-2026-10-22). Сохранность настроек, расписаний и Jobs проверена до и после обновления.

<table>
<tr><th>Snapshot File Manager</th><th>Sanoid snapshot policies</th><th>Syncoid Replication Wizard</th></tr>
<tr>
<td><img src="docs/images/file-manager.png" alt="Snapshot File Manager with synthetic files" width="280"></td>
<td><img src="docs/images/policies.png" alt="Sanoid Managed and External policies with synthetic datasets" width="280"></td>
<td><img src="docs/images/replication-wizard.png" alt="Syncoid replication wizard with synthetic datasets" width="280"></td>
</tr>
</table>

## Установка в Unraid

1. Откройте **Plugins → Install Plugin**.
2. Вставьте URL и нажмите **Install**:

   ```text
   https://github.com/d1-m4ss/zfs-director/releases/download/2026.10.22.1/zfs-director.plg
   ```

3. Откройте **Main → ZFS Director**.

Установщик сам скачает и проверит готовый пакет, создаст своё хранилище и запустит фоновые службы. **Терминал, отдельная активация и ручное создание папок не нужны.** В новой конфигурации интеграция Sanoid / Syncoid выключена. Существующие настройки, Jobs и расписания сохраняются.

Также доступны [ZIP и контрольные суммы](https://github.com/d1-m4ss/zfs-director/releases/tag/2026.10.22.1). Для прежних регистраций используйте соответствующий совместимый PLG из [инструкции установки, обновления и rollback](docs/INSTALLATION.md).

## Snapshot File Manager

### Найти, скачать и восстановить файлы

Откройте **Datasets → выберите filesystem dataset → File Manager**, выберите snapshot и нажмите **Open File Manager**. Также файлы можно открыть из списка snapshots.

Snapshot File Manager открывает содержимое выбранного snapshot. Есть переходы по каталогам, поиск, сортировка, страницы и множественный выбор. Для файлов и папок можно подготовить ZIP; подготовка и серверная передача отображаются в Jobs.

![File Manager с вымышленными файлами](docs/images/file-manager.png)

Для restore выберите файлы, назначение и режим, затем запросите свежий review. До подтверждения видны target, selection, объём и conflicts. При поддерживаемом overwrite workflow заменённые данные сохраняются для recovery; перед очисткой проверьте результат.

![Review восстановления демонстрационных файлов](docs/images/restore-review.png)


### Создать и просмотреть точку восстановления

1. Выберите dataset и откройте **Snapshots**.
2. Нажмите **Take Snapshot**, проверьте цель и при необходимости включите потомков.
3. Используйте поиск и фильтры; recursive view добавляет snapshots дочерних datasets.
4. Откройте операции нужного snapshot или его File Manager.

Holds, clones и реальные filesystem references могут блокировать удаление. Локальный snapshot — точка восстановления, а не замена независимой резервной копии.

![Список сгенерированных snapshots](docs/images/snapshots.png)


## Политики Sanoid

Обнаружение и разрешение управления находятся в **Settings → Sanoid / Syncoid Integration**. Пункты **Snapshot Policies** и **Replication** появляются, когда установлены совместимые инструменты, интеграция разрешена и проверки конфигурации/планировщика прошли.

Sanoid / Syncoid — необязательная интеграция. **Её включение разрешает Director проверять конфигурацию и управлять рассмотренными definitions. Оно само по себе не создаёт policies, не принимает чужие scripts и не запускает replication.** Каждая definition имеет собственное состояние.

В политике разделены:

- **Время создания snapshots:** час/минута внутри включённого периода.
- **Срок хранения:** retention window для каждого периода.
- **Удаление старых допустимых snapshots:** основная настройка с backend-защитой.

Пример: каждый час в `:00`, хранить 24 часа; ежедневно в `03:00`, хранить 7 дней. Используется timezone сервера. Частота служебной проверки расписания и время создания snapshot — разные понятия; обычная настройка не требует ввода cron. Templates, exclusions и специальные параметры доступны в Advanced.

![Создание демонстрационной политики snapshots](docs/images/snapshot-policy.png)

### Разделение External и Managed

| Владелец | Значение |
| --- | --- |
| External | Существующая конфигурация Sanoid или scripts остаются под внешним управлением; Director показывает их для inspection |
| Managed | Проверенная definition и её расписание хранятся в собственном persistent state Director |

Review передачи ownership создаёт выключенную Managed definition только после проверки, что предыдущий launcher неактивен. Director не переписывает User Scripts или внешние расписания автоматически. Manual snapshot не становится Managed из-за похожего на Sanoid имени.

Создание через Sanoid и retention внутри Director разделены. Native pruning не должен обходить GUID ownership и защитные проверки Director. Чужие/manual snapshots, holds, clones и replication references сохраняются, если backend не может безопасно разрешить удаление.

![Managed и External policies с вымышленными данными](docs/images/policies.png)


## Репликация Syncoid

Wizard разделён на **Source → Destination → Schedule → Review**. Поддерживаются локальные pools и SSH-получатель при корректных credentials, правах и native prerequisites.

Просмотр или сохранение definition не запускает передачу. Enable и Run требуют явного действия. Успешный exit code Syncoid не считается достаточным доказательством: результат учитывает identity получателя и checkpoint evidence. Прерванная/resumable операция остаётся видимой для inspection. Автоматический rollback получателя в этот workflow не входит.

![Wizard репликации с демонстрационным source](docs/images/replication-wizard.png)

![Вымышленная локальная репликация и записанный результат](docs/images/replication.png)


## Возможности

| Раздел | Что доступно |
| --- | --- |
| Overview | Импортированные pools, индикаторы здоровья, объём и состояние фоновых задач |
| Datasets | Дерево Workspace и режим Compact, поиск, фильтры, свойства и использование места |
| Действия с datasets | Создание, переименование, свойства, квоты, POSIX ACL, lock/unlock шифрования, clones и проверяемый Promote в поддерживаемых условиях |
| Snapshots | Создание, поиск, фильтры, просмотр потомков, rename, hold/release, clone, удаление и rollback с проверкой области |
| Snapshot File Manager | Просмотр файлов snapshot, подготовка ZIP и восстановление с предварительным review |
| Каталоги | Просмотр, move/rename, конвертация в dataset, защищённое удаление и inspection recovery |
| Snapshot Policies | Sanoid, время создания, retention и разделение External / Managed |
| Replication | Syncoid Wizard для локального pool или SSH-получателя, расписание и проверенный результат |
| Jobs | Операции, progress, ошибки, история этапов, recovery-контролы, фильтры и страницы |
| Pool & Scrub | Native diagnostics, progress scrub, подтверждённый запуск и чтение существующего расписания |

### Почему Sanoid и Syncoid

После проверки сценариев snapshots, хранения, репликации и ownership мы выбрали **Sanoid + Syncoid как более подходящий вариант для ZFS Director, чем продолжение интеграции ZnapZend**. Sanoid отвечает за создание snapshots, Syncoid — за репликацию, а Director — за GUI, расписания, Jobs и защитные проверки.

| Проверка Director | Результат локальных regression / API-тестов | Зачем это нужно |
| --- | --- | --- |
| [Время создания и хранение](tests/sanoid-times.php) | Время проверяется и сохраняется при записи/чтении конфигурации; хранение настраивается отдельно | Понятно, когда создаются snapshots и сколько они хранятся |
| [Безопасный Managed retention](tests/sanoid.php) | В конфигурации Sanoid задано `autoprune = no`; похожее имя не присваивает ownership manual snapshot; изменённые GUID, holds и базы репликации блокируют удаление | Решение об удалении остаётся за проверками Director |
| [Подтверждение репликации](tests/syncoid.php) | Отсутствие checkpoint у получателя, смена identity и частичная передача не превращаются в успех только из-за exit code 0 | Успех подтверждается состоянием получателя |
| [Ownership External / Managed](tests/ownership-transfer.test.mjs) | Review сохраняет выключенную definition; активный, неизвестный или повторно включённый внешний launcher блокирует конфликтующий Managed-запуск | Чужие скрипты остаются у владельца, двойной запуск проверяется |
| [Jobs и recovery](tests/protection-jobs.php) | Сохраняются проверенный результат и этапы; прерванная работа требует inspection вместо автоматического деструктивного восстановления | Результаты snapshots и репликации видны и доступны для проверки |

Эти проверки подтверждают выбранную архитектуру интеграции Director; охват native-тестов описан в [Testing](docs/TESTING.md). Прямой benchmark производительности или равнозначную приёмку ZnapZend мы не проводили. Вывод относится к workflow этого плагина и не означает, что ZnapZend хуже для любых задач. Поэтому ZnapZend исключён из активной интеграции.

![Overview с вымышленными pools](docs/images/overview.png)


## Рабочая область

**Workspace** показывает дерево и детали выбранного объекта рядом. **Compact** уплотняет представление. При переходе между совместимыми объектами выбранная вкладка сохраняется: можно последовательно просматривать snapshots или Actions без постоянного возврата из Overview.

Доступны темы **Black, Gray, White, Azure** и **Unraid (auto)** с наследованием темы хоста. Интерфейс адаптируется к узкому экрану. Длинные формы и review прокручиваются внутри ограниченного окна.

![Workspace с полностью сгенерированными datasets](docs/images/datasets.png)

![Компактная таблица датасетов с вымышленными данными](docs/images/compact.png)

<details>
<summary>Другие темы и узкий экран</summary>

![Gray](docs/images/theme-gray.png)

![White](docs/images/theme-light.png)

![Azure](docs/images/theme-azure.png)

<img src="docs/images/mobile.png" alt="Демонстрационный Overview на узком экране" width="390">

</details>


## Действия с datasets и каталогами

![Действия с датасетом на вымышленных данных](docs/images/actions.png)

Actions открывает модальный редактор, затем отдельный review. Заголовок и нижние кнопки остаются доступны; длинное содержимое прокручивается внутри. **Back** возвращает редактор, **Close** закрывает окно и возвращает фокус. Закрытие не отменяет уже принятый backend запрос.

![Ограниченное окно review удаления вымышленного dataset](docs/images/deletion-review.png)

Для разрушительных действий нужны соответствующий режим, свежая inventory, identity цели и отдельное подтверждение. Удаление dataset/snapshots требует свежего серверного preview с точной областью, GUID и зависимостями. Удаление корня pool запрещено. Force не останавливает приложения, не снимает holds и не удаляет посторонние clones.

Подтверждённый read-only Docker mount родителя не блокирует удаление каждого обычного дочернего каталога. Writable и неизвестные режимы, ссылки на сам каталог или его содержимое и вложенные mounts остаются защищёнными. Worker повторно проверяет зависимости перед выполнением.

### Конвертация каталога с сохранением оригинала

Конвертация выполняется как фоновый Job. Сначала остановите всех writers, обеспечьте место для копий и после завершения проверьте содержимое. Копирование выполняется в ограниченном workflow; оригинал сохраняется для recovery.

Новые сохранённые оригиналы получают понятное имя: например, `incoming_archived_<дата-время>`. Старые recovery-имена остаются прежними. Внутренние `.zfsm-mutation-*` обычно скрыты из дерева и доступны через Jobs / recovery files. Незавершённые операции и сохранённые данные защищены; это не обычные папки для безусловного удаления. Очистка допустимых завершённых временных данных требует свежего review.


## Jobs: операции, progress и recovery

Jobs собирает операции, запрошенные через Director: создание snapshots, restore, подготовку и скачивание ZIP, конвертацию, удаление, изменения конфигурации и Data Protection runs. У внешних scripts остаются их владелец и собственная история исполнения.

- Числовой progress показывается при наличии измерения. Иначе виден этап, без придуманного процента.
- Ошибки связываются с операцией и доступным безопасным контекстом.
- История различает копирование, verification, публикацию и recovery.
- Удаление допустимых snapshots с сохранением защищённых имеет результат **Completed with warnings** и понятный итог.
- Доступны фильтры и страницы: по умолчанию **10 записей**, можно выбрать больше.
- Resume/cleanup появляются только при поддержке backend; завершённая или небезопасная работа не возобновляется автоматически.

![Демонстрационные Jobs: progress, предупреждение retention и страницы](docs/images/jobs.png)

### Ограничение объёма истории

Worker проверяет необходимость обслуживания истории раз в час. По умолчанию: 30 дней, мягкие лимиты 1000 записей / 32 MiB, минимум 100 последних записей и ограниченные batches очистки. Активные, ошибочные/recovery, referenced и retained-data записи защищены. Эти лимиты не разрешают удалять пользовательские данные или оригиналы recovery; защищённая история может превышать мягкий лимит и требовать inspection.


## Окружение и состояние

Текущее целевое окружение — **Unraid 7.3.3 с OpenZFS 2.4.4**. Это не обещание совместимости со всеми версиями. Native prerequisites проверяются во время работы; неподдерживаемые kernel/filesystem APIs блокируют операцию безопасным отказом. Для Data Protection нужна совместимая доверенная установка Sanoid / Syncoid.

Director сам создаёт и обслуживает постоянное и временное хранилище. Обновления сохраняют существующие настройки и journals. Code-only rollback не должен заменять актуальное состояние старым backup.

Ошибка доверия к правам/цепочке путей требует inspection, а не массового chmod. Внешние расписания и scripts не принимаются и не исправляются автоматически.

![Демонстрационные detection и Settings](docs/images/settings.png)


## Состояние релиза и известные ограничения

- **Консервативный ZIP cleanup:** новые ZIP Jobs сохраняют GUID пула. Если импортирован именно этот пул, повторная inventory подтверждает отсутствие GUID dataset/snapshot и всего исходного пути, устаревшее состояние ZIP/hold сверяется без удаления файлов. Старые Jobs без GUID пула, переименованные объекты, сохранённые пути, недоступный пул и неполная проверка остаются для inspection. Нельзя принудительно удалять locks или вслепую редактировать journals.
- **Проверка загрузки:** установка, обновление и обычный reboot проверены в изолированной Unraid VM. Физическое оборудование, восстановление после потери питания и native reboot с pending recovery пока не проверены.
- **Охват платформ:** GUI/PHP-моки и Linux filesystem tests не равнозначны native Unraid/OpenZFS acceptance. Проверки физического touch и screen readers неполны.
- **Дистрибуция:** релиз RC1 содержит установочный ZIP, SHA256SUMS и соответствующие PLG/TGZ. Автоматический канал обновлений и широкая сторонняя приёмка ещё не проверены.

Защитные механизмы снижают риск случайного расширения области операции, но не заменяют независимый backup, остановку writers и проверку оператором.


## Структура репозитория

```text
src/                 Плагин, интерфейс и native helpers
tests/               Регрессионные, GUI- и интеграционные тесты
tools/               Сборщик пакета и проверки релиза
docs/                Установка, разработка и тестирование
docs/images/         Скриншоты с вымышленными данными
docs/preview/        Демонстрация и инструменты съёмки скриншотов
```

Все скриншоты документации используют вымышленные данные. Конфигурация сервера, учётные данные, Jobs и резервные копии не входят в репозиторий и установочный ZIP.


## Лицензия и происхождение

GPL-2.0-or-later. Original ZFS Master: Carlos Rodriguez (IkerSaint), copyright 2021. Остальные upstream adaptations и сохранённые notices описаны в [NOTICE.md](src/NOTICE.md). Исходная runtime license сохранена в `src/LICENSE`, полный текст — в [LICENSE](LICENSE) и `src/COPYING`.


## Для разработчиков

Сборка из исходников, тесты и синтетическая демонстрация описаны в [developer guide](docs/DEVELOPMENT.md). Для установки эти шаги не нужны.
