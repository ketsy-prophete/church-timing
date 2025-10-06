using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChurchTiming.Api.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Runs",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    MasterStartAtUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    PreteachSec = table.Column<int>(type: "INTEGER", nullable: false),
                    WalkBufferSec = table.Column<int>(type: "INTEGER", nullable: false),
                    BaseOfferingSec = table.Column<int>(type: "INTEGER", nullable: false),
                    SpanishSermonEndedAtSec = table.Column<int>(type: "INTEGER", nullable: true),
                    SpanishSermonEndEtaSec = table.Column<int>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Runs", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Segments",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    RunId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Order = table.Column<int>(type: "INTEGER", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    PlannedSec = table.Column<int>(type: "INTEGER", nullable: false),
                    ActualSec = table.Column<int>(type: "INTEGER", nullable: true),
                    DriftSec = table.Column<int>(type: "INTEGER", nullable: true),
                    Completed = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Segments", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Segments_Runs_RunId",
                        column: x => x.RunId,
                        principalTable: "Runs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Segments_RunId",
                table: "Segments",
                column: "RunId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Segments");

            migrationBuilder.DropTable(
                name: "Runs");
        }
    }
}
